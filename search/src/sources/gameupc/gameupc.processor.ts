import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { ApiCacheService } from '../../common/cache/api-cache.service';
import { GAMEUPC_CLIENT, GameUpcClient, GameUpcError } from './gameupc.client';
import {
  CachedGameUpcLookup,
  GAMEUPC_LOOKUP_LIMITER,
  GAMEUPC_QUEUE,
  GAMEUPC_RATE_LIMIT_PAUSE_MS,
  GAMEUPC_SEARCH_MODE,
  GameUpcLookupJobData,
  LAST_KNOWN_TTL_SECONDS,
  lastKnownCacheKey,
  lookupCacheKey,
  lookupTtlSeconds,
} from './gameupc.types';

/**
 * Seul point du code qui consulte GameUPC. Le limiter borne le débit tous utilisateurs confondus ;
 * le cache est écrit ici, sur 2xx seulement.
 *
 * Deux entrées par consultation sans termes de recherche : la réponse (TTL selon le statut) et la
 * **dernière réponse connue** (90 j), que le service de résolution sert marquée `stale` quand
 * GameUPC ne répond plus. Une consultation avec termes n'écrit que la première : elle reflète une
 * saisie, pas l'état du code.
 */
@Processor(GAMEUPC_QUEUE, { concurrency: 1, limiter: GAMEUPC_LOOKUP_LIMITER })
export class GameUpcLookupProcessor extends WorkerHost {
  constructor(
    @Inject(GAMEUPC_CLIENT) private readonly client: GameUpcClient,
    private readonly cache: ApiCacheService,
  ) {
    super();
  }

  async process(
    job: Job<GameUpcLookupJobData, CachedGameUpcLookup>,
  ): Promise<CachedGameUpcLookup> {
    const { upc, search } = job.data;

    let entry: CachedGameUpcLookup;
    try {
      const info = await this.client.lookup(upc, {
        search,
        mode: GAMEUPC_SEARCH_MODE,
      });
      entry = { info, fetchedAt: new Date().toISOString() };
    } catch (err) {
      await pauseOnRateLimit(this.worker, err);
      throw err;
    }

    await this.cache.set(
      lookupCacheKey(upc, search),
      entry,
      lookupTtlSeconds(entry.info),
    );
    if (search === null) {
      await this.cache.set(
        lastKnownCacheKey(upc),
        entry,
        LAST_KNOWN_TTL_SECONDS,
      );
    }
    return entry;
  }
}

/**
 * `429` : la limite est globale chez GameUPC, pas propre au job. On met **toute la file** en pause
 * (`Retry-After`, sinon 30 s) au lieu de laisser les jobs suivants taper le même mur ; le job
 * courant échoue quand même, pour que son nombre de tentatives reste borné.
 */
export async function pauseOnRateLimit(
  worker: Worker,
  err: unknown,
): Promise<void> {
  if (err instanceof GameUpcError && err.kind === 'rate_limited') {
    await worker.rateLimit(err.retryAfterMs ?? GAMEUPC_RATE_LIMIT_PAUSE_MS);
  }
}
