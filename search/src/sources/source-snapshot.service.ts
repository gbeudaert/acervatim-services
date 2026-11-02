import { Inject, Injectable } from '@nestjs/common';
import { InternalSourceSnapshotResponse } from '../common/internal/contracts';
import { SourceAdapter, UnifiedItem } from './adapters/types';

/** Token DI : tableau des adapters externes connus (un par source). */
export const SOURCE_ADAPTERS = Symbol('SOURCE_ADAPTERS');

/**
 * Pre-remplissage de la verite curee a partir d'une reference provider.
 *
 * **Ce service a change de cote.** Dans le monolithe il vivait dans `common/sources/` et etait
 * appele en memoire par `items` et `nodes` a chaque `POST .../sources`. Les adapters ayant
 * suivi `search` - ce sont eux qui appellent les catalogues externes, tiennent les files
 * BullMQ et portent les cles serveur -, il est desormais expose aux catalogs par
 * `POST /internal/sources/snapshot`.
 *
 * Le comportement, lui, est identique : provider connu -> `fetchDetails` remplit `rawData` ;
 * provider sans adapter (`bnf`, `mangadex`, `isbn`) -> la reference est conservee telle
 * quelle, avec `rawData` et `fetchedAt` a `null`. Cette distinction porte une regle du contrat
 * V1 : une source vers un provider sans adapter **et** sans `unifiedData` est un `400` cote
 * catalog, parce que rien ne decrirait la ressource.
 */
@Injectable()
export class SourceSnapshotService {
  private readonly byProvider: Map<string, SourceAdapter>;

  constructor(@Inject(SOURCE_ADAPTERS) adapters: SourceAdapter[]) {
    this.byProvider = new Map(adapters.map((a) => [a.source, a]));
  }

  hasAdapter(provider: string): boolean {
    return this.byProvider.has(provider);
  }

  async snapshot(
    provider: string,
    externalId: string,
    userId: string,
  ): Promise<InternalSourceSnapshotResponse> {
    const adapter = this.byProvider.get(provider);
    if (!adapter) {
      return { provider, externalId, rawData: null, fetchedAt: null };
    }
    const unified: UnifiedItem = await adapter.fetchDetails(externalId, {
      userId,
      limit: 1,
    });
    return {
      provider,
      externalId,
      rawData: unified,
      fetchedAt: new Date().toISOString(),
    };
  }
}
