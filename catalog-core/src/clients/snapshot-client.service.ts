import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  InternalSourceSnapshotResponse,
  InternalSourceSnapshotRequest,
} from '../contracts';
import { SourceEntry, SourceRef } from '../types/common';
import {
  CATALOG_CONFIG,
  CatalogConfig,
  INTERNAL_TRANSPORT,
  InternalTransport,
} from './registry-client.service';

/**
 * Pre-remplissage de la verite curee a partir d'une reference provider.
 *
 * Remplace le `SourceSnapshotService` que le monolithe avait en memoire : les adapters ont
 * suivi `search` - ce sont eux qui appellent les catalogues externes, tiennent les files
 * BullMQ et portent les cles serveur -, et le catalog les interroge desormais par
 * `POST /internal/sources/snapshot`.
 *
 * La forme du resultat est **inchangee** (`SourceEntry`), y compris la distinction qui porte
 * une regle du contrat V1 :
 *
 *  - `rawData` renseigne -> un adapter a decrit la reference, elle peut pre-remplir un noeud ;
 *  - `rawData: null` -> provider sans adapter (`bnf`, `mangadex`, `gbooks`). La reference est
 *    conservee telle quelle, et une source de ce genre **sans** `unifiedData` est un `400` :
 *    rien ne decrirait la ressource.
 *
 * `search` injoignable donne le meme `rawData: null`. C'est le repli le moins mauvais :
 * refuser l'ecriture priverait l'utilisateur de sa donnee pour une panne d'enrichissement,
 * alors que la reference, elle, est parfaitement stockable. Le cas est journalise pour ne pas
 * se confondre avec un provider reellement sans adapter.
 */
@Injectable()
export class SnapshotClientService {
  private readonly logger = new Logger(SnapshotClientService.name);

  constructor(
    @Inject(INTERNAL_TRANSPORT) private readonly internal: InternalTransport,
    @Inject(CATALOG_CONFIG) private readonly config: CatalogConfig,
  ) {}

  async snapshot(ref: SourceRef, userId: string): Promise<SourceEntry> {
    const baseUrl = this.config.searchBaseUrl;
    const bare: SourceEntry = {
      provider: ref.provider,
      externalId: ref.externalId,
      rawData: null,
      fetchedAt: null,
    };
    if (!baseUrl) return bare;

    const body: InternalSourceSnapshotRequest = {
      userId,
      provider: ref.provider,
      externalId: ref.externalId,
    };
    const res = await this.internal.tryRequest<InternalSourceSnapshotResponse>(
      baseUrl,
      '/internal/sources/snapshot',
      { method: 'POST', body },
    );
    if (!res) {
      this.logger.warn(
        `snapshot indisponible pour ${ref.provider} - reference conservee sans enrichissement`,
      );
      return bare;
    }
    return {
      provider: res.provider,
      externalId: res.externalId,
      rawData: res.rawData,
      fetchedAt: res.fetchedAt,
    };
  }
}
