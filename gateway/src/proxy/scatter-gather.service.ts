import { Injectable, Logger } from '@nestjs/common';
import { Request } from 'express';
import {
  ServiceName,
  ServiceRegistryService,
} from '../routing/service-registry.service';
import {
  CompositeCursor,
  EXHAUSTED,
  SortableCollection,
  compareCollections,
  decodeCompositeCursor,
  encodeCompositeCursor,
} from './composite-cursor';
import { ProxyService } from './proxy.service';

interface CursorPage<T> {
  data: T[];
  meta: { pagination: { nextCursor: string | null; limit: number } };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * `GET /v1/collections` sur plusieurs catalogs (3.7 de architecture-microservices.md).
 *
 * Les filtres `type[in]` et `items[in]`/`items[all]` traversent tous les types. Chaque
 * catalog applique le sien sur **ses** items - c'est justement ce que la separation des
 * schemas permet encore de faire localement - et le gateway ne fait que fusionner et
 * ordonner.
 *
 * Choix ecarte : restreindre l'appel aux seuls types que le registre de routage attribue a
 * l'utilisateur. Ce serait moins de requetes, mais un registre divergent produirait alors
 * une liste **incomplete et silencieuse** - le pire mode de defaillance possible pour une
 * galerie. Le registre sert a router une ressource nommee, pas a decider ce qui existe.
 */
@Injectable()
export class ScatterGatherService {
  private readonly logger = new Logger(ScatterGatherService.name);

  constructor(
    private readonly proxy: ProxyService,
    private readonly services: ServiceRegistryService,
  ) {}

  async listCollections(
    req: Request,
    principalHeader: string | undefined,
  ): Promise<CursorPage<SortableCollection>> {
    const query = { ...(req.query as Record<string, unknown>) };
    const limit = parseLimit(query.limit);
    const cursor = decodeCompositeCursor(
      typeof query.cursor === 'string' ? query.cursor : undefined,
    );

    const targets = this.resolveTargets(query);
    // Les services deja epuises ne sont plus interroges : sans ca, une liste dominee par
    // un seul type declencherait N-1 requetes vides a chaque page.
    const active = targets.filter((t) => cursor[t] !== EXHAUSTED);

    const pages = await Promise.all(
      active.map(async (service) => {
        const page = await this.fetchPage(
          service,
          req,
          principalHeader,
          query,
          cursor[service],
          limit,
        );
        return { service, page };
      }),
    );

    return this.merge(pages, cursor, targets, limit);
  }

  /** Catalogs a interroger : ceux du `type[in]`, tous s'il est absent. */
  private resolveTargets(query: Record<string, unknown>): ServiceName[] {
    const typeFilter = query.type;
    const raw =
      typeFilter &&
      typeof typeFilter === 'object' &&
      typeof (typeFilter as { in?: unknown }).in === 'string'
        ? (typeFilter as { in: string }).in
        : undefined;
    if (!raw) return this.services.availableCatalogs();

    const codes = raw
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    const wanted = new Set<ServiceName>();
    for (const code of codes) {
      // Un type inconnu n'est pas rejete ici : c'est le catalog qui porte la whitelist Zod
      // du contrat, et le gateway ne doit pas dupliquer une validation qui divergerait.
      const target = CATALOG_OR_UNDEFINED(code);
      if (target && this.services.find(target)) wanted.add(target);
    }
    return [...wanted];
  }

  private async fetchPage(
    service: ServiceName,
    req: Request,
    principalHeader: string | undefined,
    query: Record<string, unknown>,
    cursor: string | undefined,
    limit: number,
  ): Promise<CursorPage<SortableCollection>> {
    const search = new URLSearchParams();
    // Filtres relayes tels quels, dans la forme `field[in]` que qs produit et que les
    // catalogs savent lire.
    appendFilter(search, 'type', query.type);
    appendFilter(search, 'items', query.items);
    search.set('limit', String(limit));
    if (cursor && cursor !== EXHAUSTED) search.set('cursor', cursor);

    const baseUrl = this.services.require(service);
    const upstream = await this.proxy.call(
      baseUrl,
      req,
      principalHeader,
      `/v1/collections?${search.toString()}`,
    );
    if (upstream.status >= 400) {
      // Une page partielle serait indistinguable d'une liste courte : on preferer echouer
      // franchement plutot que de rendre une galerie amputee sans le dire.
      this.logger.warn(
        `scatter-gather: ${service} a repondu ${upstream.status}`,
      );
      throw new ScatterGatherUpstreamError(upstream.status, upstream.body);
    }
    return this.proxy.parseJson<CursorPage<SortableCollection>>(upstream.body);
  }

  private merge(
    pages: Array<{ service: ServiceName; page: CursorPage<SortableCollection> }>,
    previous: CompositeCursor,
    targets: ServiceName[],
    limit: number,
  ): CursorPage<SortableCollection> {
    const flat = pages.flatMap(({ service, page }) =>
      page.data.map((row) => ({ service, row })),
    );
    flat.sort((a, b) => compareCollections(a.row, b.row));

    const taken = flat.slice(0, limit);

    // Position de reprise : le dernier element **effectivement consomme** chez chaque
    // service. Un service dont rien n'a ete pris garde sa position precedente - ses lignes
    // n'ont pas ete servies, elles ne doivent pas etre sautees.
    const next: CompositeCursor = { ...previous };
    for (const service of targets) {
      const page = pages.find((p) => p.service === service);
      if (!page) continue;
      const lastTaken = [...taken].reverse().find((t) => t.service === service);
      if (lastTaken) next[service] = lastTaken.row.id;

      const consumedAll = page.page.data.length === 0 ||
        page.page.data.every((row) =>
          taken.some((t) => t.service === service && t.row.id === row.id),
        );
      // Epuise seulement si le service a rendu une page incomplete ET qu'on l'a videe :
      // une page pleine peut toujours avoir une suite.
      if (page.page.data.length < limit && consumedAll) {
        next[service] = EXHAUSTED;
      }
    }

    const hasMore =
      flat.length > limit ||
      targets.some((s) => next[s] !== undefined && next[s] !== EXHAUSTED);

    return {
      data: taken.map((t) => t.row),
      meta: {
        pagination: {
          nextCursor: hasMore ? encodeCompositeCursor(next) : null,
          limit,
        },
      },
    };
  }
}

/** Erreur d'un catalog pendant une fusion : relayee telle quelle au client. */
export class ScatterGatherUpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly body: Buffer,
  ) {
    super(`upstream ${status}`);
  }
}

function parseLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/** Reserialise `{ in: 'a,b' }` en `field[in]=a,b`. */
function appendFilter(
  search: URLSearchParams,
  field: string,
  value: unknown,
): void {
  if (!value || typeof value !== 'object') return;
  for (const [op, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string' && raw.length > 0) {
      search.set(`${field}[${op}]`, raw);
    }
  }
}

/** Duplique volontairement `CATALOG_BY_TYPE` sans lever sur un code inconnu. */
function CATALOG_OR_UNDEFINED(code: string): ServiceName | undefined {
  switch (code) {
    case 'manga':
      return 'catalog-manga';
    case 'vinyl':
      return 'catalog-vinyl';
    case 'movie':
    case 'book':
    case 'game':
      return 'catalog-generic';
    default:
      return undefined;
  }
}
