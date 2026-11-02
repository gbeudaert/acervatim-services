import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { HarvestRun } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  BricksetBudgetExhaustedError,
  BricksetNotConfiguredError,
  BricksetService,
} from '../brickset/brickset.service';
import { RebrickableCallContext } from '../rebrickable/rebrickable.service';
import { RebrickableService } from '../rebrickable/rebrickable.service';
import { SetIndexService } from './set-index.service';
import { ThemeSyncService } from './theme-sync.service';

/**
 * Contexte d'appel des travaux de fond. `premium: true` n'accorde aucun droit a un humain : il
 * force `TokenResolverPort` a servir la **cle serveur**, la seule qui ait un sens pour un job
 * qui n'appartient a personne. `userId` n'est jamais porteur d'un compte reel.
 */
const SYSTEM_CTX: RebrickableCallContext = {
  userId: 'system',
  premium: true,
};

const REBRICKABLE_PAGE_SIZE = 1000;
/**
 * Plafond de pages par passage Rebrickable. A 1 req/s, 30 pages = 30 s de debit sortant et
 * ~30 000 sets - assez pour un catalogue complet en un passage, sans monopoliser la file si
 * l'API renvoie une pagination inattendue.
 */
const REBRICKABLE_MAX_PAGES = 30;

export interface HarvestReport {
  source: string;
  mode: string;
  state: string;
  pages: number;
  setsUpserted: number;
  callsUsed: number;
  stoppedBy?: string;
}

/**
 * Moissonnage de l'index local.
 *
 * Deux campagnes, aux contraintes opposees :
 *  - **Rebrickable** : debit borne (~1 req/s) mais volume libre. Un catalogue complet passe en
 *    un seul passage nocturne.
 *  - **Brickset** : volume plafonne (100 appels `getSets`/jour sur une cle libre). Une campagne
 *    complete tient en ~45 appels a `pageSize: 500`, donc en une nuit dans le cas nominal - mais
 *    elle DOIT etre reprenable, parce qu'un budget entame par ailleurs, une coupure ou un
 *    changement de plafond la coupe en cours de route. D'ou `HarvestRun`, qui memorise la
 *    derniere page consommee : on reprend a la page suivante, jamais au debut.
 *
 * Apres la premiere campagne complete, Brickset passe en **incremental** via `updatedSince`,
 * ce qui ramene le cout quotidien a quelques appels.
 */
@Injectable()
export class HarvestService {
  private readonly logger = new Logger(HarvestService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rebrickable: RebrickableService,
    private readonly brickset: BricksetService,
    private readonly index: SetIndexService,
    private readonly themes: ThemeSyncService,
  ) {}

  /**
   * Passage nocturne. Le verrou `running` est **intra-processus** : il suffit tant que le service
   * tourne en un exemplaire. Passer a plusieurs replicas exigera un verrou Redis - a traiter au
   * moment ou la question se pose, pas avant.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async nightly(): Promise<void> {
    if (this.running) {
      this.logger.warn('moissonnage deja en cours, passage ignore');
      return;
    }
    this.running = true;
    try {
      if (this.themes.isEmpty()) {
        const n = await this.themes.sync(SYSTEM_CTX);
        this.logger.log(`themes: ${n} synchronises`);
      }
      await this.harvestRebrickable();
      await this.harvestBrickset();
      this.index.logSummary(await this.index.count());
    } catch (err) {
      this.logger.error(
        `moissonnage nocturne interrompu: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }

  /** Catalogue Rebrickable : nom, annee, theme, nombre de pieces, visuel. */
  async harvestRebrickable(): Promise<HarvestReport> {
    const run = await this.startRun('rebrickable', 'full');
    let pages = 0;
    let upserted = 0;
    let stoppedBy: string | undefined;

    try {
      for (let page = run.lastPage + 1; ; page++) {
        if (pages >= REBRICKABLE_MAX_PAGES) {
          stoppedBy = 'page-cap';
          break;
        }
        const res = await this.rebrickable.searchSets(SYSTEM_CTX, {
          page,
          pageSize: REBRICKABLE_PAGE_SIZE,
        });
        upserted += await this.index.upsertFromRebrickable(res.results);
        pages++;
        await this.checkpoint(run.id, {
          lastPage: page,
          setsUpserted: upserted,
        });
        if (!res.next) {
          // Catalogue parcouru : la campagne suivante repart de la page 1.
          await this.finishRun(run.id, 'done', { lastPage: 0 });
          return report(run, pages, upserted, 0, 'done', stoppedBy);
        }
      }
      await this.finishRun(run.id, 'paused');
      return report(run, pages, upserted, 0, 'paused', stoppedBy);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.finishRun(run.id, 'failed', { lastError: message });
      this.logger.error(`rebrickable: moissonnage echoue - ${message}`);
      return report(run, pages, upserted, 0, 'failed', message);
    }
  }

  /** Codes-barres Brickset, sous budget journalier, reprenable page a page. */
  async harvestBrickset(): Promise<HarvestReport> {
    if (!this.brickset.isConfigured()) {
      this.logger.warn(
        'brickset: non configure, aucun code-barres ne sera indexe',
      );
      return {
        source: 'brickset',
        mode: 'none',
        state: 'skipped',
        pages: 0,
        setsUpserted: 0,
        callsUsed: 0,
        stoppedBy: 'not-configured',
      };
    }

    const previous = await this.prisma.harvestRun.findFirst({
      where: { source: 'brickset', state: 'done', mode: 'full' },
      orderBy: { finishedAt: 'desc' },
    });
    // Le premier passage complet fait l'index ; ensuite on ne demande que ce qui a bouge.
    const mode = previous ? 'incremental' : 'full';
    const updatedSince =
      mode === 'incremental' && previous?.watermark
        ? previous.watermark.toISOString().slice(0, 10)
        : undefined;

    const run = await this.startRun('brickset', mode);
    // Borne haute figee AVANT le premier appel : tout set modifie pendant la campagne sera
    // repris au passage suivant. Prendre l'heure de fin creerait une fenetre aveugle.
    const watermark = new Date();
    const pageSize = 500;

    let pages = 0;
    let upserted = 0;
    let calls = 0;
    let stoppedBy: string | undefined;

    try {
      for (let page = run.lastPage + 1; ; page++) {
        const res = await this.brickset.getSets({
          pageNumber: page,
          pageSize,
          updatedSince,
          orderBy: 'Number',
        });
        calls++;
        pages++;
        const sets = res.sets ?? [];
        upserted += await this.index.upsertFromBrickset(sets);
        await this.checkpoint(run.id, {
          lastPage: page,
          setsUpserted: upserted,
          callsUsed: calls,
        });

        if (sets.length < pageSize) {
          await this.finishRun(run.id, 'done', { lastPage: 0, watermark });
          return report(run, pages, upserted, calls, 'done');
        }
      }
    } catch (err) {
      if (err instanceof BricksetBudgetExhaustedError) {
        // Arret nominal, pas une panne : la campagne reprend demain a la page suivante.
        stoppedBy = 'daily-budget';
        await this.finishRun(run.id, 'paused', { lastError: err.message });
        this.logger.log(
          `brickset: ${err.message} - reprise demain page ${run.lastPage + pages + 1}`,
        );
        return report(run, pages, upserted, calls, 'paused', stoppedBy);
      }
      if (err instanceof BricksetNotConfiguredError) {
        await this.finishRun(run.id, 'skipped');
        return report(run, pages, upserted, calls, 'skipped', 'not-configured');
      }
      const message = err instanceof Error ? err.message : String(err);
      await this.finishRun(run.id, 'failed', { lastError: message });
      this.logger.error(`brickset: moissonnage echoue - ${message}`);
      return report(run, pages, upserted, calls, 'failed', message);
    }
  }

  async lastRuns(): Promise<HarvestRun[]> {
    return this.prisma.harvestRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 10,
    });
  }

  /**
   * Ouvre une campagne, ou reprend celle qui a ete mise en pause. Un run `failed` n'est pas
   * repris automatiquement : on repart de sa position mais dans une nouvelle ligne, pour que
   * l'historique garde la trace de l'echec.
   */
  private async startRun(source: string, mode: string): Promise<HarvestRun> {
    const paused = await this.prisma.harvestRun.findFirst({
      where: { source, state: { in: ['paused', 'failed'] } },
      orderBy: { startedAt: 'desc' },
    });
    return this.prisma.harvestRun.create({
      data: { source, mode, state: 'running', lastPage: paused?.lastPage ?? 0 },
    });
  }

  private async checkpoint(
    id: string,
    data: { lastPage: number; setsUpserted: number; callsUsed?: number },
  ): Promise<void> {
    await this.prisma.harvestRun.update({ where: { id }, data });
  }

  private async finishRun(
    id: string,
    state: string,
    extra: { lastPage?: number; lastError?: string; watermark?: Date } = {},
  ): Promise<void> {
    await this.prisma.harvestRun.update({
      where: { id },
      data: { state, finishedAt: new Date(), ...extra },
    });
  }
}

function report(
  run: HarvestRun,
  pages: number,
  setsUpserted: number,
  callsUsed: number,
  state: string,
  stoppedBy?: string,
): HarvestReport {
  return {
    source: run.source,
    mode: run.mode,
    state,
    pages,
    setsUpserted,
    callsUsed,
    stoppedBy,
  };
}
