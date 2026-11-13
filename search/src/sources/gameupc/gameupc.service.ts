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
import { GAMEUPC_CLIENT, GameUpcClient } from './gameupc.client';
import {
  CachedGameUpcLookup,
  GAMEUPC_FEEDBACK_QUEUE,
  GAMEUPC_LOOKUP_JOB,
  GAMEUPC_QUEUE,
  GAMEUPC_VOTE_JOB,
  GameUpcLookupJobData,
  GameUpcVoteJobData,
  GameUpcVoteOutcome,
  lastKnownCacheKey,
  lookupCacheKey,
  voteJobId,
} from './gameupc.types';

/** Familles de mesure du cache (`/v1/admin/queues`), de cardinal borné. */
const LOOKUP_FAMILY = 'gameupc:upc';
const LAST_KNOWN_FAMILY = 'gameupc:last';

/**
 * Attente d'une consultation. GameUPC répond en ~0,5-1,5 s (mode `quality`, première requête
 * jusqu'à 1 s de plus) ; 8 s laissent passer une petite file sans approcher les 10 s d'OkHttp.
 */
const LOOKUP_WAIT_MS = 8_000;

/**
 * Retry des votes : 30 s, 1, 2, 4, 8 min — une quinzaine de minutes pour traverser une panne ou une
 * vague de `429`. Le vote n'est attendu par personne : il peut prendre son temps.
 */
const VOTE_ATTEMPTS = 6;
const VOTE_BACKOFF_MS = 30_000;
/** Un vote en échec définitif reste visible une semaine dans `/v1/admin/queues`. */
const VOTE_FAILED_RETENTION_SECONDS = 7 * 24 * 3600;

/**
 * **Producteur** GameUPC : cache → sinon file `gameupc` (débit borné, single-flight par code) →
 * attente du worker. Et l'entrée de la file de feedback. Ne jette jamais sur le chemin interactif :
 * `null` couvre clé absente, Redis indisponible, échec et délai dépassé, que le service de
 * résolution traduit en repli.
 */
@Injectable()
export class GameUpcService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GameUpcService.name);
  private queueEvents!: QueueEvents;

  constructor(
    @InjectQueue(GAMEUPC_QUEUE)
    private readonly lookupQueue: Queue<
      GameUpcLookupJobData,
      CachedGameUpcLookup
    >,
    @InjectQueue(GAMEUPC_FEEDBACK_QUEUE)
    private readonly feedbackQueue: Queue<
      GameUpcVoteJobData,
      GameUpcVoteOutcome
    >,
    @Inject(GAMEUPC_CLIENT) private readonly client: GameUpcClient,
    private readonly config: ConfigService,
    private readonly cache: ApiCacheService,
    private readonly redisHealth: RedisHealthService,
  ) {}

  onModuleInit(): void {
    this.queueEvents = new QueueEvents(GAMEUPC_QUEUE, {
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

  /** Consultation d'un code **déjà normalisé**, avec ou sans termes de recherche (normalisés). */
  async lookup(
    upc: string,
    search: string | null,
  ): Promise<CachedGameUpcLookup | null> {
    const key = lookupCacheKey(upc, search);
    const cached = await this.cache.get<CachedGameUpcLookup>(
      key,
      LOOKUP_FAMILY,
    );
    if (cached) return cached;

    if (!this.client.enabled || !this.redisHealth.isAvailable()) return null;

    try {
      const job = await this.lookupQueue.add(
        GAMEUPC_LOOKUP_JOB,
        { upc, search },
        {
          // Single-flight : deux scans simultanés du même code ne font qu'un appel.
          jobId: key,
          removeOnComplete: { age: 60, count: 500 },
          // Interactif : pas de retry différé, l'utilisateur attend et le repli prend le relais.
          attempts: 1,
          removeOnFail: true,
        },
      );
      return (await job.waitUntilFinished(
        this.queueEvents,
        LOOKUP_WAIT_MS,
      )) as CachedGameUpcLookup;
    } catch {
      this.logger.warn(`gameupc: lookup failed upc=${upc}`);
      return null;
    }
  }

  /** Consultation déjà en cache (sans termes de recherche), jamais de réseau ni de file. */
  async cachedLookup(upc: string): Promise<CachedGameUpcLookup | null> {
    return this.cache.get<CachedGameUpcLookup>(
      lookupCacheKey(upc, null),
      LOOKUP_FAMILY,
    );
  }

  /** Dernière réponse connue d'un code (cache seul, jamais de réseau), pour le repli `stale`. */
  async lastKnown(upc: string): Promise<CachedGameUpcLookup | null> {
    return this.cache.get<CachedGameUpcLookup>(
      lastKnownCacheKey(upc),
      LAST_KNOWN_FAMILY,
    );
  }

  /**
   * Enfile un vote. `false` si rien n'a pu être enfilé (clé absente, Redis indisponible) : le choix
   * de l'utilisateur vaut quand même pour lui, seul le partage avec GameUPC est perdu.
   *
   * `removeOnComplete: true` est voulu : le `jobId` ne déduplique que les envois **en cours**. Un
   * job terminé gardé en mémoire avalerait un retour au premier choix (A, puis B, puis A) ; un
   * renvoi du même vote après coup, lui, est sans effet chez GameUPC.
   */
  async enqueueVote(
    vote: Omit<GameUpcVoteJobData, 'chosenAt'>,
    chosenAt: Date = new Date(),
  ): Promise<boolean> {
    if (!this.client.enabled || !this.redisHealth.isAvailable()) return false;
    try {
      await this.feedbackQueue.add(
        GAMEUPC_VOTE_JOB,
        { ...vote, chosenAt: chosenAt.toISOString() },
        {
          jobId: voteJobId(vote),
          attempts: VOTE_ATTEMPTS,
          backoff: { type: 'exponential', delay: VOTE_BACKOFF_MS },
          removeOnComplete: true,
          removeOnFail: { age: VOTE_FAILED_RETENTION_SECONDS },
        },
      );
      return true;
    } catch {
      this.logger.warn(`gameupc: vote enqueue failed upc=${vote.upc}`);
      return false;
    }
  }
}
