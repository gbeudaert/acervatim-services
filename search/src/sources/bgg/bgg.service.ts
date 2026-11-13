import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, QueueEvents } from 'bullmq';
import { ApiCacheService } from '../../common/cache/api-cache.service';
import { RedisHealthService } from '../../common/redis/redis-health.service';
import { BGG_CLIENT, BggClient } from './bgg.client';
import {
  BGG_QUEUE,
  BGG_THING_JOB,
  BggThing,
  BggThingJobData,
  CachedBggThing,
  thingCacheKey,
} from './bgg.types';

const THING_FAMILY = 'bgg:thing';

/**
 * Attente d'une fiche. Au-delà, l'appelant reçoit `null` et le job continue en arrière-plan : la
 * fiche sera en cache au prochain passage. La file étant à une requête toutes les 2 s, une
 * attente plus longue ne ferait que retenir l'utilisateur derrière les autres.
 */
const THING_WAIT_MS = 6_000;
const THING_ATTEMPTS = 4;
const THING_BACKOFF_MS = 10_000;

/**
 * **Producteur** des fiches BGG : cache (30 j) → file `bgg` → attente. Best-effort, ne jette
 * jamais : licence absente, Redis indisponible, BGG en pause ou délai dépassé donnent `null`, et la
 * résolution se contente des données GameUPC.
 */
@Injectable()
export class BggThingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BggThingService.name);
  private queueEvents!: QueueEvents;

  constructor(
    @InjectQueue(BGG_QUEUE)
    private readonly queue: Queue<BggThingJobData, CachedBggThing>,
    @Inject(BGG_CLIENT) private readonly client: BggClient,
    private readonly config: ConfigService,
    private readonly cache: ApiCacheService,
    private readonly redisHealth: RedisHealthService,
  ) {}

  onModuleInit(): void {
    this.queueEvents = new QueueEvents(BGG_QUEUE, {
      connection: {
        host: this.config.get<string>('REDIS_HOST', 'localhost'),
        port: this.config.get<number>('REDIS_PORT', 6379),
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queueEvents?.close();
  }

  get enabled(): boolean {
    return this.client.enabled;
  }

  async thing(bggId: number): Promise<BggThing | null> {
    if (!this.client.enabled) return null;

    const key = thingCacheKey(bggId);
    const cached = await this.cache.get<CachedBggThing>(key, THING_FAMILY);
    if (cached) return cached.thing;

    if (!this.redisHealth.isAvailable()) return null;

    try {
      const job = await this.queue.add(
        BGG_THING_JOB,
        { bggId },
        {
          jobId: key,
          removeOnComplete: { age: 60, count: 500 },
          attempts: THING_ATTEMPTS,
          backoff: { type: 'exponential', delay: THING_BACKOFF_MS },
          removeOnFail: true,
        },
      );
      const res = (await job.waitUntilFinished(
        this.queueEvents,
        THING_WAIT_MS,
      )) as CachedBggThing;
      return res?.thing ?? null;
    } catch {
      this.logger.warn(`bgg: thing not resolved in time bggId=${bggId}`);
      return null;
    }
  }
}
