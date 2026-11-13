import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { ApiCacheService } from '../../common/cache/api-cache.service';
import { BGG_CLIENT, BggClient, BggError } from './bgg.client';
import {
  BGG_LIMITER,
  BGG_QUEUE,
  BGG_RATE_LIMIT_PAUSE_MS,
  BggThingJobData,
  CachedBggThing,
  THING_MISS_TTL_SECONDS,
  THING_TTL_SECONDS,
  thingCacheKey,
} from './bgg.types';

/**
 * Seul point du code qui appelle BGG. `concurrency: 1` + limiter 1 / 2 s : comme chaque job ne
 * fait qu'**une** requête (pas de retry transport), le débit sortant ne peut pas dépasser la règle,
 * retries compris — ils repassent par le limiter.
 *
 * Sur `429`/`503`, toute la file est mise en pause (`Retry-After`, sinon 60 s) : la limite est celle
 * du compte Acervatim chez BGG, pas celle d'un jeu.
 */
@Processor(BGG_QUEUE, { concurrency: 1, limiter: BGG_LIMITER })
export class BggProcessor extends WorkerHost {
  constructor(
    @Inject(BGG_CLIENT) private readonly client: BggClient,
    private readonly cache: ApiCacheService,
  ) {
    super();
  }

  async process(
    job: Job<BggThingJobData, CachedBggThing>,
  ): Promise<CachedBggThing> {
    const { bggId } = job.data;
    let entry: CachedBggThing;
    try {
      entry = { thing: await this.client.thing(bggId) };
    } catch (err) {
      if (err instanceof BggError) {
        if (err.kind === 'rate_limited') {
          await this.worker.rateLimit(
            err.retryAfterMs ?? BGG_RATE_LIMIT_PAUSE_MS,
          );
        } else if (err.kind !== 'unavailable') {
          // Jeton refusé, requête invalide, client désactivé : retenter ne changera rien.
          throw new UnrecoverableError(`bgg: ${err.kind}: ${err.message}`);
        }
      }
      throw err;
    }

    await this.cache.set(
      thingCacheKey(bggId),
      entry,
      entry.thing ? THING_TTL_SECONDS : THING_MISS_TTL_SECONDS,
    );
    return entry;
  }
}
