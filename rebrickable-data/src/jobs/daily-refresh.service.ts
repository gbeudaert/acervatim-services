import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import {
  BricksetHarvestService,
  HarvestReport,
} from '../brickset/brickset-harvest.service';
import { ApiCacheService } from '../common/cache/api-cache.service';
import {
  ImportReport,
  RebrickableCsvService,
} from '../import/rebrickable-csv.service';
import { PrismaService } from '../prisma/prisma.service';

/** Tous les jours a 03:00 **UTC** - le fuseau est fixe, pas celui de l'hote. */
export const DAILY_REFRESH_CRON = '0 0 3 * * *';
export const DAILY_REFRESH_TIMEZONE = 'UTC';

export interface RefreshReport {
  import: ImportReport | null;
  harvest: HarvestReport | null;
}

/**
 * Le seul passage planifie du service : import des CSV Rebrickable **puis** campagne Brickset.
 *
 * L'ordre compte - les nouveautes du jour doivent exister avant qu'on leur cherche un code-barres
 * - mais le second ne depend pas du succes du premier : un import `unchanged` ou `failed` laisse
 * un catalogue valide, et le budget Brickset du jour serait perdu si on ne le depensait pas.
 *
 * Au demarrage (hors `NODE_ENV=test`), un catalogue vide declenche le meme enchainement **en
 * tache de fond** : le service repond tout de suite, vide, puis se remplit.
 *
 * Import et campagne restent chacun en single-flight : un appel `/admin/*` concurrent se rattache
 * au passage en cours au lieu d'en lancer un second.
 */
@Injectable()
export class DailyRefreshService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DailyRefreshService.name);
  /** Passage lance au demarrage, garde pour que les tests puissent l'attendre. */
  bootRefresh: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly importer: RebrickableCsvService,
    private readonly harvest: BricksetHarvestService,
    private readonly cache: ApiCacheService,
    private readonly config: ConfigService,
  ) {}

  @Cron(DAILY_REFRESH_CRON, {
    name: 'daily-refresh',
    timeZone: DAILY_REFRESH_TIMEZONE,
  })
  async daily(): Promise<void> {
    await this.refresh('quotidien');
  }

  onApplicationBootstrap(): void {
    if (this.config.get<string>('NODE_ENV') === 'test') return;
    // Volontairement non attendu : le boot ne doit pas dependre du reseau.
    this.bootRefresh = this.refreshIfEmpty();
  }

  async refreshIfEmpty(): Promise<void> {
    try {
      if ((await this.prisma.legoSet.count()) > 0) return;
      this.logger.log(
        'catalogue vide au demarrage : import puis moissonnage en tache de fond',
      );
      await this.refresh('demarrage');
    } catch (err) {
      this.logger.error(`demarrage: ${errorMessage(err)}`);
    }
  }

  /** Import puis campagne Brickset. Ne leve jamais : chaque etape journalise son echec. */
  async refresh(trigger: string): Promise<RefreshReport> {
    let importReport: ImportReport | null = null;
    try {
      importReport = await this.importer.run();
      this.logger.log(
        `${trigger}: import ${importReport.state} (${importReport.rowsUpserted} sets, ${importReport.themes} themes)`,
      );
    } catch (err) {
      this.logger.error(`${trigger}: import interrompu - ${errorMessage(err)}`);
    }

    try {
      // Les seules entrees de `api_cache` sont les compteurs de budget : purge des jours passes.
      await this.cache.pruneExpired();
    } catch (err) {
      this.logger.warn(`${trigger}: purge du cache - ${errorMessage(err)}`);
    }

    let harvestReport: HarvestReport | null = null;
    try {
      harvestReport = await this.harvest.run();
      this.logger.log(
        `${trigger}: brickset ${harvestReport.state} (${harvestReport.rowsUpserted} sets annotes, ${harvestReport.unmatched} sans correspondance)`,
      );
    } catch (err) {
      this.logger.error(
        `${trigger}: campagne brickset interrompue - ${errorMessage(err)}`,
      );
    }
    return { import: importReport, harvest: harvestReport };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
