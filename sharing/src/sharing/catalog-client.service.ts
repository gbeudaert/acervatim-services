import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CollectionTypeCode,
  InternalCollectionOwner,
  InternalItemCountRequest,
  InternalItemCountResponse,
  ShareStatus,
} from '../common/internal/contracts';
import {
  InternalCallError,
  InternalClientService,
} from '../common/internal/internal-client.service';

/** Quel catalog sert quel type. Duplique la table du gateway - voir le JSDoc de classe. */
const CATALOG_ENV_BY_TYPE: Record<CollectionTypeCode, string> = {
  manga: 'CATALOG_MANGA_BASE_URL',
  vinyl: 'CATALOG_VINYL_BASE_URL',
  lego: 'CATALOG_LEGO_BASE_URL',
  movie: 'CATALOG_GENERIC_BASE_URL',
  book: 'CATALOG_GENERIC_BASE_URL',
  game: 'CATALOG_GENERIC_BASE_URL',
};

export interface CollectionSummary {
  collectionId: string;
  ownerUserId: string;
  typeCode: CollectionTypeCode;
  name: string;
}

/**
 * Acces aux catalogs depuis `sharing`. C'est le cote « appelant » de l'inversion de
 * dependance du 3.1.
 *
 * Dans le monolithe, `sharing` lisait directement `collections` et `items` - jointure SQL
 * comprise. La dependance etait bidirectionnelle et ne survit pas a la separation des
 * schemas. Desormais `sharing` demande, le catalog repond, et le filtrage par statut se fait
 * **chez le catalog** : le `status` d'un item vit dans son `userData`, donc chez lui.
 *
 * Ce service duplique la table type -> catalog du gateway. C'est volontaire : la partager
 * exigerait une dependance entre deux `apps/`, ce que l'invariant du 1 interdit. Deux tables
 * de cinq lignes qui peuvent diverger valent mieux qu'un couplage qui rendrait le decoupage
 * cosmetique - et un type inconnu echoue franchement des les deux cotes.
 */
@Injectable()
export class CatalogClientService {
  private readonly logger = new Logger(CatalogClientService.name);

  constructor(
    private readonly internal: InternalClientService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Proprietaire, type et nom d'une collection - appele a la **creation** d'un partage.
   *
   * Le type n'etant pas connu a ce moment (le client n'envoie que des identifiants), on
   * interroge les catalogs configures **en parallele** et on retient celui qui repond. C'est
   * la seule diffusion de la constellation, et elle est acceptable ici parce que la creation
   * d'un partage est rare et que le resultat est ensuite denormalise : les lectures
   * ulterieures vont droit au bon catalog.
   *
   * `null` si aucun catalog ne connait cette collection - indistinguable de « elle appartient
   * a quelqu'un d'autre », ce qui est exactement la convention voulue.
   */
  async findCollection(collectionId: string): Promise<CollectionSummary | null> {
    const targets = this.configuredCatalogs();
    const results = await Promise.all(
      targets.map(async (baseUrl) => {
        try {
          return await this.internal.request<InternalCollectionOwner>(
            baseUrl,
            `/internal/collections/${encodeURIComponent(collectionId)}/owner`,
          );
        } catch (err) {
          // 404 est la reponse nominale d'un catalog qui ne sert pas ce type.
          if (err instanceof InternalCallError && err.status === 404) {
            return null;
          }
          throw err;
        }
      }),
    );
    return results.find((r): r is InternalCollectionOwner => r !== null) ?? null;
  }

  /**
   * Nombre d'items visibles sous les statuts exposes, pour un lot d'entrees (3.2).
   *
   * **Un appel par catalog concerne, en parallele - jamais un par entree.** Le monolithe
   * notait deja que le proprietaire n'a pas ce compte, parce qu'il couterait une requete par
   * entree et par partage sur une liste non plafonnee ; la remarque est devenue le contrat.
   *
   * Un catalog injoignable ne fait pas echouer la lecture du partage : les entrees
   * concernees ressortent sans compte (`null`). Un membre doit pouvoir voir **quelles**
   * collections on lui partage meme quand un catalog est en panne ; afficher `0` a la place
   * lui ferait croire que le partage est vide.
   */
  async countItems(
    entries: Array<{
      collectionId: string;
      typeCode: CollectionTypeCode;
      statuses: ShareStatus[];
    }>,
  ): Promise<Map<string, { count: number | null; name: string | null }>> {
    const byCatalog = new Map<
      string,
      InternalItemCountRequest['entries']
    >();
    for (const entry of entries) {
      const baseUrl = this.baseUrlFor(entry.typeCode);
      if (!baseUrl) continue;
      const bucket = byCatalog.get(baseUrl) ?? [];
      bucket.push({
        collectionId: entry.collectionId,
        statuses: entry.statuses,
      });
      byCatalog.set(baseUrl, bucket);
    }

    const out = new Map<string, { count: number | null; name: string | null }>();
    // Toutes les entrees demarrent « indisponible » : une reponse manquante ne doit pas
    // devenir un zero par omission.
    for (const entry of entries) {
      out.set(entry.collectionId, { count: null, name: null });
    }

    await Promise.all(
      [...byCatalog.entries()].map(async ([baseUrl, bucket]) => {
        const res = await this.internal.tryRequest<InternalItemCountResponse>(
          baseUrl,
          '/internal/items/count',
          { method: 'POST', body: { entries: bucket }, timeoutMs: 5_000 },
        );
        if (!res) {
          this.logger.warn(
            `comptage indisponible : ${bucket.length} entree(s) sans compte`,
          );
          return;
        }
        for (const row of res.counts) {
          out.set(row.collectionId, { count: row.count, name: row.name });
        }
      }),
    );

    return out;
  }

  /** Proprietaire, ou 404 - jamais un message qui confirmerait l'existence ailleurs. */
  async requireCollection(collectionId: string): Promise<CollectionSummary> {
    const found = await this.findCollection(collectionId);
    if (!found) throw new NotFoundException('Collection not found');
    return found;
  }

  private baseUrlFor(typeCode: CollectionTypeCode): string | undefined {
    const key = CATALOG_ENV_BY_TYPE[typeCode];
    return key ? this.config.get<string>(key) : undefined;
  }

  private configuredCatalogs(): string[] {
    const urls = new Set<string>();
    for (const key of Object.values(CATALOG_ENV_BY_TYPE)) {
      const url = this.config.get<string>(key);
      if (url) urls.add(url);
    }
    return [...urls];
  }
}
