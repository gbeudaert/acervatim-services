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
import { ApiCacheService } from '../common/cache/api-cache.service';
import { RedisHealthService } from '../common/redis/redis-health.service';
import {
  BRICKSET_QUEUE,
  BricksetFetchJobData,
  BricksetGetSetsParams,
  BricksetGetSetsResponse,
} from './brickset.types';

const FETCH_JOB = 'fetch';
/** Le moissonneur n'est pas interactif : il peut attendre longtemps un worker throttle. */
const WAIT_MS = 60_000;

/** Levee quand le budget journalier est epuise. Le moissonneur s'arrete proprement et reprend demain. */
export class BricksetBudgetExhaustedError extends Error {
  constructor(
    readonly used: number,
    readonly budget: number,
  ) {
    super(`brickset: budget journalier epuise (${used}/${budget})`);
  }
}

/** Levee quand aucune cle Brickset n'est configuree : l'index se construit sans codes-barres. */
export class BricksetNotConfiguredError extends Error {
  constructor() {
    super('brickset: BRICKSET_API_KEY absent');
  }
}

/**
 * Acces a Brickset, **exclusivement hors ligne**.
 *
 * Brickset est la seule source gratuite qui publie l'EAN et l'UPC d'une boite - la donnee sans
 * laquelle le scan d'un set est impossible. Mais une cle libre plafonne a 100 appels `getSets`
 * par jour, ce qui interdit categoriquement de l'interroger sur le chemin d'une requete
 * utilisateur : un seul utilisateur actif consommerait le quota de tous les autres.
 *
 * D'ou la forme retenue : on **moissonne** le catalogue par pages de 500 (le maximum autorise,
 * soit ~45 appels pour la totalite des references), on stocke EAN/UPC dans `lego_sets`, et la
 * recherche par code-barres devient une lecture locale a cout reseau nul. Le budget est compte
 * ici pour que le moissonneur s'arrete de lui-meme avant le refus d'API.
 */
@Injectable()
export class BricksetService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BricksetService.name);
  private apiKey?: string;
  private dailyBudget!: number;
  private queueEvents!: QueueEvents;

  constructor(
    private readonly config: ConfigService,
    private readonly cache: ApiCacheService,
    private readonly redisHealth: RedisHealthService,
    @InjectQueue(BRICKSET_QUEUE)
    private readonly queue: Queue<BricksetFetchJobData, unknown>,
  ) {}

  onModuleInit(): void {
    this.apiKey = this.config.get<string>('BRICKSET_API_KEY');
    this.dailyBudget = this.config.get<number>(
      'BRICKSET_DAILY_CALL_BUDGET',
      90,
    );
    this.queueEvents = new QueueEvents(BRICKSET_QUEUE, {
      connection: {
        host: this.config.get<string>('REDIS_HOST', 'localhost'),
        port: this.config.get<number>('REDIS_PORT', 6379),
      },
    });
    // Obligatoire : sans ecouteur, une erreur de connexion Redis remonterait comme une
    // exception non geree et ferait tomber le processus. La reconnexion est automatique.
    this.queueEvents.on('error', (err: Error) =>
      this.logger.warn(`brickset: evenements de file - ${err.message}`),
    );
    if (!this.apiKey) {
      this.logger.warn(
        'BRICKSET_API_KEY absent : l index se construira sans codes-barres, le scan restera muet',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.queueEvents?.close();
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  /** Appels deja consommes aujourd'hui, et budget total. Expose par `GET /admin/status`. */
  async budgetStatus(): Promise<{ used: number; budget: number }> {
    return {
      used: await this.callsUsed(budgetKey()),
      budget: this.dailyBudget,
    };
  }

  /**
   * Une page de `getSets`. Chaque appel consomme une unite de budget - c'est la seule methode
   * de ce service qui touche le reseau, donc le seul endroit ou compter.
   */
  async getSets(
    params: BricksetGetSetsParams,
  ): Promise<BricksetGetSetsResponse> {
    if (!this.apiKey) throw new BricksetNotConfiguredError();

    // Cle calculee UNE fois : a minuit UTC, relire puis ecrire sous deux cles differentes
    // inscrirait le compte d'hier sous la date du jour.
    const key = budgetKey();
    const used = await this.callsUsed(key);
    if (used >= this.dailyBudget) {
      throw new BricksetBudgetExhaustedError(used, this.dailyBudget);
    }
    // Avant de consommer : une file indisponible ne doit pas bruler une unite sans appel.
    if (!this.redisHealth.isAvailable()) {
      throw new ServiceUnavailableException(
        'brickset: file indisponible (Redis)',
      );
    }

    // Le compteur est incremente AVANT l'appel : un appel parti puis perdu (timeout, crash)
    // a bel et bien consomme du quota cote Brickset. Sous-compter ferait depasser le plafond,
    // ce qui coute une journee entiere de moissonnage - surcompter ne coute qu'un appel.
    await this.setUsed(key, used + 1);

    const body = await this.enqueueFetch<BricksetGetSetsResponse>(
      stripUndefined(params),
    );
    if (body?.status !== 'success') {
      if (isQuotaRefusal(body?.message)) {
        // Brickset a deja ferme la journee (appels faits ailleurs avec la meme cle, compteur
        // perdu...) : on sature le compteur pour ne plus rien envoyer d'ici minuit UTC.
        await this.setUsed(key, this.dailyBudget);
        throw new BricksetBudgetExhaustedError(
          this.dailyBudget,
          this.dailyBudget,
        );
      }
      throw new BadGatewayException(
        `brickset: ${body?.message ?? 'reponse inattendue'}`,
      );
    }
    return body;
  }

  private async callsUsed(key: string): Promise<number> {
    const row = await this.cache.get<{ count: number }>(key);
    return row?.count ?? 0;
  }

  /**
   * Read-modify-write non atomique, ce qui est acceptable ici et seulement ici : le moissonneur
   * est mono-job (`concurrency: 1` cote worker, campagne en single-flight). Si le service devait
   * un jour moissonner en parallele, ce compteur passerait a un `INCR` Redis.
   */
  private async setUsed(key: string, count: number): Promise<void> {
    // TTL de 48 h : couvre le decalage entre le jour UTC et le jour de reference de Brickset
    // sans laisser trainer des compteurs de la semaine passee.
    await this.cache.set(key, { count }, 48 * 3600);
  }

  private async enqueueFetch<T>(
    params: Partial<BricksetGetSetsParams>,
  ): Promise<T> {
    try {
      const job = await this.queue.add(
        FETCH_JOB,
        { params },
        {
          // Pas de `jobId` derive des parametres : un jobId stable rejouerait un resultat
          // conserve alors qu'on veut bien un appel neuf par page.
          removeOnComplete: { age: 600, count: 200 },
          removeOnFail: true,
        },
      );
      return (await job.waitUntilFinished(this.queueEvents, WAIT_MS)) as T;
    } catch (err) {
      this.logger.warn(
        `brickset: echec file/upstream ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadGatewayException('brickset: upstream unavailable');
    }
  }
}

/** Compteur du jour UTC. */
export function budgetKey(now: Date = new Date()): string {
  return `brickset:budget:${now.toISOString().slice(0, 10)}`;
}

/** Refus de quota cote Brickset : "API limit exceeded". */
function isQuotaRefusal(message: string | undefined): boolean {
  return /limit exceeded/i.test(message ?? '');
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
