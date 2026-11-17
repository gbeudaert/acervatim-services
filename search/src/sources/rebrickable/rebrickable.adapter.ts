import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  InternalLegoBarcodeLookup,
  InternalLegoSet,
  InternalLegoSetPage,
} from '../../common/internal/contracts';
import {
  InternalCallError,
  InternalClientService,
} from '../../common/internal/internal-client.service';
import {
  AdapterContext,
  AdapterSearchResult,
  SourceAdapter,
  UnifiedItem,
} from '../adapters/types';

/**
 * Attente de `rebrickable-data` sur le scan : il peut attendre Brickset jusqu'a
 * `BRICKSET_SCAN_WAIT_MS` (6 s) avant de rendre `pending`. 8 s laissent cette marge, et restent
 * sous le delai du client mobile (10 s). Les autres routes gardent le delai interne par defaut.
 */
export const BARCODE_TIMEOUT_MS = 8_000;

/** Borne de `offset` cote `rebrickable-data` : au-dela, il repond `400`. */
const MAX_OFFSET = 100_000;

/**
 * Source `rebrickable` du type `lego`.
 *
 * **Elle n'appelle aucun service externe.** Le catalogue des sets est celui de
 * `rebrickable-data` (CSV publics Rebrickable, codes-barres Brickset au scan), lu par ses routes
 * `/internal/*`. Ni l'API Rebrickable ni Brickset ne sont appeles d'ici, et aucune cle n'est en
 * jeu : il n'y a donc ni file BullMQ, ni cache, ni jeton utilisateur - le voisin est local et ses
 * reponses sont deja des lectures de base.
 *
 * Le curseur est le decalage de la page suivante, en clair : il reste opaque pour l'app.
 */
@Injectable()
export class RebrickableAdapter implements SourceAdapter, OnModuleInit {
  readonly source = 'rebrickable' as const;
  readonly mediaType = 'lego' as const;

  private readonly logger = new Logger(RebrickableAdapter.name);
  private baseUrl: string | null = null;

  constructor(
    private readonly internal: InternalClientService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.baseUrl =
      this.config.get<string>('REBRICKABLE_DATA_BASE_URL') ?? null;
    if (!this.baseUrl) {
      this.logger.warn(
        'REBRICKABLE_DATA_BASE_URL absent - la recherche LEGO repondra 503',
      );
    }
  }

  async search(
    query: string,
    ctx: AdapterContext,
  ): Promise<AdapterSearchResult> {
    const offset = parseOffset(ctx.cursor);
    const params = new URLSearchParams({
      q: query,
      offset: String(offset),
      limit: String(ctx.limit),
    });
    const page = await this.get<InternalLegoSetPage>(
      `/internal/sets?${params.toString()}`,
    );
    const next = offset + page.items.length;
    return {
      items: page.items.map(toUnifiedItem),
      nextCursor: page.hasMore && next <= MAX_OFFSET ? String(next) : null,
    };
  }

  /**
   * Un scan peut rendre plusieurs sets (multipacks, editions regionales) : l'app propose le
   * choix, le serveur ne tranche jamais. `lookup` dit d'ou vient la reponse et si un nouveau
   * scan a un sens (`pending`, `exhausted`...) ; il est recopie dans `meta.barcodeLookup`.
   */
  async searchByBarcode(
    barcode: string,
    _ctx: AdapterContext,
  ): Promise<AdapterSearchResult> {
    const res = await this.get<InternalLegoBarcodeLookup>(
      `/internal/sets/by-barcode/${encodeURIComponent(barcode)}`,
      BARCODE_TIMEOUT_MS,
    );
    return {
      items: res.items.map(toUnifiedItem),
      nextCursor: null,
      meta: { barcodeLookup: res.lookup },
    };
  }

  async fetchDetails(id: string, _ctx: AdapterContext): Promise<UnifiedItem> {
    try {
      const set = await this.get<InternalLegoSet>(
        `/internal/sets/${encodeURIComponent(id)}`,
        undefined,
        true,
      );
      return toUnifiedItem(set);
    } catch (err) {
      if (err instanceof InternalCallError && err.status === 404) {
        throw new NotFoundException(`rebrickable: set '${id}' not found`);
      }
      throw err;
    }
  }

  /**
   * Lecture d'une route de `rebrickable-data`. Voisin injoignable : `502` (leve par le client
   * interne). Voisin qui repond une erreur : `502` aussi, sauf un `404` que l'appelant a demande
   * a voir (`keepNotFound`) - une requete mal formee ici serait un defaut de cet adapter, pas de
   * l'app, et ne doit pas lui revenir en `400`.
   */
  private async get<T>(
    path: string,
    timeoutMs?: number,
    keepNotFound = false,
  ): Promise<T> {
    if (!this.baseUrl) {
      throw new ServiceUnavailableException(
        'rebrickable-data is not configured',
      );
    }
    try {
      return await this.internal.request<T>(this.baseUrl, path, {
        timeoutMs,
      });
    } catch (err) {
      if (err instanceof InternalCallError) {
        if (keepNotFound && err.status === 404) throw err;
        this.logger.warn(`rebrickable-data: ${err.status} sur ${redact(path)}`);
        throw new BadGatewayException('rebrickable-data: upstream error');
      }
      throw err;
    }
  }
}

/** Correspondance `InternalLegoSet` vers `UnifiedItem` (conception F10). */
export function toUnifiedItem(set: InternalLegoSet): UnifiedItem {
  return {
    source: 'rebrickable',
    sourceId: set.setNum,
    mediaType: 'lego',
    title: set.name,
    // Un set n'a pas d'auteur.
    creators: [],
    releaseDate: set.year === null ? undefined : String(set.year),
    coverUrl: set.imageUrl ?? undefined,
    metadata: {
      setNum: set.setNum,
      setNumber: set.setNumber,
      theme: set.theme,
      numParts: set.numParts,
      minifigs: set.minifigs,
      barcodes: set.barcodes,
      contributedBy: set.contributedBy,
    },
    rawData: set,
  };
}

function parseOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^\d{1,6}$/.test(cursor) || Number(cursor) > MAX_OFFSET) {
    throw new BadRequestException('invalid cursor');
  }
  return Number(cursor);
}

/** Retire la query string : elle porte la saisie de l'utilisateur. */
function redact(path: string): string {
  const q = path.indexOf('?');
  return q === -1 ? path : path.slice(0, q);
}
