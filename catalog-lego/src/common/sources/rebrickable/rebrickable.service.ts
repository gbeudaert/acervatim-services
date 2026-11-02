import { InjectQueue } from '@nestjs/bullmq';
import {
  BadGatewayException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, QueueEvents } from 'bullmq';
import { createHash } from 'crypto';
import { ApiCacheService } from '../../cache/api-cache.service';
import { RedisHealthService } from '../../redis/redis-health.service';
import { SourceTokenRequiredException } from '../source-token-required.exception';
import { TokenResolverPort } from '../token-resolver.port';
import {
  REBRICKABLE_QUEUE,
  RebrickableFetchJobData,
  RebrickablePage,
  RebrickableSet,
  RebrickableTheme,
} from './rebrickable.types';

const FETCH_JOB = 'fetch';
/** Plafond d'attente du worker sur le chemin interactif. Au-dela : 502. */
const WAIT_MS = 15_000;

// Le catalogue LEGO officiel est immuable a l'echelle de la journee : un set publie ne change ni
// de nom ni de nombre de pieces. On peut donc cacher long. Un TTL court n'aurait de sens que pour
// les nouveautes, qui arrivent par vagues annoncees - le moissonneur les rattrape.
const SEARCH_TTL_SECONDS = 6 * 3600;
const SET_TTL_SECONDS = 30 * 86_400;
const THEMES_TTL_SECONDS = 7 * 86_400;

export interface RebrickableCallContext {
  userId: string;
  premium: boolean;
}

/**
 * Acces a Rebrickable - source **nominale** du catalogue LEGO (nom, annee, theme, nombre de
 * pieces, visuel). Choisie parce qu'elle est la seule des candidates a reunir un catalogue
 * complet, une cle gratuite en libre-service et un quota exploitable en ligne (~1 req/s). Elle
 * ne connait en revanche aucun code-barres : c'est le role de Brickset et de l'index local
 * (cf. `SetIndexService`).
 *
 * Tout appel sortant passe par la file `rebrickable` (debit borne + single-flight sur la cle de
 * cache) puis par `ApiCacheService`. Aucun appel direct depuis un controller.
 */
@Injectable()
export class RebrickableService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RebrickableService.name);
  private baseUrl!: string;
  private queueEvents!: QueueEvents;

  constructor(
    private readonly config: ConfigService,
    private readonly cache: ApiCacheService,
    private readonly tokens: TokenResolverPort,
    private readonly redisHealth: RedisHealthService,
    @InjectQueue(REBRICKABLE_QUEUE)
    private readonly queue: Queue<RebrickableFetchJobData, unknown>,
  ) {}

  onModuleInit(): void {
    const configured = this.config.get<string>('REBRICKABLE_BASE_URL')!;
    this.baseUrl = configured.endsWith('/')
      ? configured.slice(0, -1)
      : configured;
    this.queueEvents = new QueueEvents(REBRICKABLE_QUEUE, {
      connection: {
        host: this.config.get<string>('REDIS_HOST', 'localhost'),
        port: this.config.get<number>('REDIS_PORT', 6379),
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queueEvents?.close();
  }

  /**
   * Recherche par nom, filtrable par theme. `page` est 1-base cote Rebrickable, ce qui donne un
   * curseur naturel et stable - contrairement a un offset, il ne decale pas quand un set est
   * insere entre deux lectures.
   */
  async searchSets(
    ctx: RebrickableCallContext,
    params: { q?: string; themeId?: number; page: number; pageSize: number },
  ): Promise<RebrickablePage<RebrickableSet>> {
    const search = new URLSearchParams();
    if (params.q) search.set('search', params.q);
    if (params.themeId !== undefined) {
      search.set('theme_id', String(params.themeId));
    }
    search.set('page', String(params.page));
    search.set('page_size', String(params.pageSize));
    // Tri explicite : sans `ordering`, deux appels sur la meme page peuvent renvoyer un ordre
    // different et faire sauter ou dupliquer des lignes a la pagination.
    search.set('ordering', '-year');

    const url = `${this.baseUrl}/lego/sets/?${search.toString()}`;
    const cacheKey = `rebrickable:sets:${hash(search.toString())}`;
    return this.fetch<RebrickablePage<RebrickableSet>>(
      ctx,
      url,
      cacheKey,
      SEARCH_TTL_SECONDS,
      'rebrickable:search',
    );
  }

  /** Detail d'un set par son numero canonique ("42131-1"). */
  async getSet(
    ctx: RebrickableCallContext,
    setNum: string,
  ): Promise<RebrickableSet> {
    const url = `${this.baseUrl}/lego/sets/${encodeURIComponent(setNum)}/`;
    return this.fetch<RebrickableSet>(
      ctx,
      url,
      `rebrickable:set:${setNum}`,
      SET_TTL_SECONDS,
      'rebrickable:set',
    );
  }

  /**
   * Une page de l'arbre des themes. Consommee par `ThemeSyncService`, jamais sur le chemin d'une
   * requete utilisateur : l'API publique lit l'arbre depuis la base locale.
   */
  async fetchThemesPage(
    ctx: RebrickableCallContext,
    page: number,
    pageSize = 1000,
  ): Promise<RebrickablePage<RebrickableTheme>> {
    const url = `${this.baseUrl}/lego/themes/?page=${page}&page_size=${pageSize}&ordering=id`;
    return this.fetch<RebrickablePage<RebrickableTheme>>(
      ctx,
      url,
      `rebrickable:themes:${page}:${pageSize}`,
      THEMES_TTL_SECONDS,
      'rebrickable:themes',
    );
  }

  /**
   * Cache d'abord, **sans jeton** : un hit sert le mode degrade (ni cle personnelle, ni premium),
   * comme le monolithe le fait pour ses sources publiques. Miss et pas de jeton -> 403 typee, que
   * l'app traduit en « connecter la source ou passer premium ».
   */
  private async fetch<T>(
    ctx: RebrickableCallContext,
    url: string,
    cacheKey: string,
    ttlSeconds: number,
    family: string,
  ): Promise<T> {
    const cached = await this.cache.get<T>(cacheKey, family);
    if (cached !== null) return cached;

    const token = await this.tokens.resolve(
      ctx.userId,
      'rebrickable',
      ctx.premium,
    );
    if (!token) {
      throw new SourceTokenRequiredException('rebrickable');
    }

    const fresh = await this.enqueueFetch<T>(url, cacheKey, token.key);
    await this.cache.set(cacheKey, fresh, ttlSeconds);
    return fresh;
  }

  /**
   * Enfile un GET et attend le worker. `jobId` derive de la cle de cache : deux requetes
   * identiques concurrentes partagent un seul appel sortant (single-flight). Le hash est
   * necessaire, BullMQ refusant `:` dans un jobId.
   */
  private async enqueueFetch<T>(
    url: string,
    cacheKey: string,
    apiKey: string,
  ): Promise<T> {
    // Circuit-breaker : Redis down -> 503 immediat plutot que 15 s d'attente inutile.
    if (!this.redisHealth.isAvailable()) {
      throw new ServiceUnavailableException(
        'rebrickable: file indisponible (Redis)',
      );
    }
    try {
      const job = await this.queue.add(
        FETCH_JOB,
        { url, apiKey },
        {
          jobId: hash(cacheKey),
          removeOnComplete: { age: 60, count: 500 },
          removeOnFail: true,
        },
      );
      return (await job.waitUntilFinished(this.queueEvents, WAIT_MS)) as T;
    } catch (err) {
      this.logger.warn(
        `rebrickable: echec file/upstream ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadGatewayException('rebrickable: upstream unavailable');
    }
  }
}

function hash(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}
