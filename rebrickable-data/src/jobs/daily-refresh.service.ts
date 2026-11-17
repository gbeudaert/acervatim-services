import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { BricksetLookupService } from '../brickset/brickset-lookup.service';
import { CatalogService } from '../catalog/catalog.service';
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
  /** Sets dont les codes-barres, confirmes il y a plus de 90 jours, ont ete effaces. */
  expiredBarcodes: number | null;
}

/**
 * Le seul passage planifie du service : import des CSV Rebrickable, purge du cache, puis
 * effacement des codes-barres confirmes il y a plus de `BRICKSET_BARCODE_TTL_DAYS`.
 *
 * **Aucun appel a Brickset ici** : depuis le 2026-11-17, Brickset n'est appele qu'au scan d'un
 * code absent du cache. Chaque etape tourne meme si la precedente a echoue : un import
 * `unchanged` ou `failed` laisse un catalogue valide, et l'effacement tient l'engagement des
 * 90 jours pris aupres de Brickset.
 *
 * Au demarrage (hors `NODE_ENV=test`), un catalogue vide declenche le meme enchainement **en
 * tache de fond** : le service repond tout de suite, vide, puis se remplit.
 *
 * L'import reste en single-flight : un appel `/admin/*` concurrent se rattache au passage en
 * cours au lieu d'en lancer un second.
 */
@Injectable()
export class DailyRefreshService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DailyRefreshService.name);
  /** Passage lance au demarrage, garde pour que les tests puissent l'attendre. */
  bootRefresh: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly importer: RebrickableCsvService,
    private readonly catalog: CatalogService,
    private readonly barcodes: BricksetLookupService,
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
        'catalogue vide au demarrage : import en tache de fond',
      );
      await this.refresh('demarrage');
    } catch (err) {
      this.logger.error(`demarrage: ${errorMessage(err)}`);
    }
  }

  /** Import, purge du cache, codes expires. Ne leve jamais : chaque etape journalise son echec. */
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
      // `api_cache` ne porte que les compteurs de budget et les codes marques inconnus : purge
      // des entrees echues.
      await this.cache.pruneExpired();
    } catch (err) {
      this.logger.warn(`${trigger}: purge du cache - ${errorMessage(err)}`);
    }

    let expiredBarcodes: number | null = null;
    try {
      expiredBarcodes = await this.catalog.purgeExpiredBarcodes(
        this.barcodes.freshSince(),
      );
      if (expiredBarcodes > 0) {
        this.logger.log(
          `${trigger}: codes-barres de ${expiredBarcodes} sets effaces (plus de 90 jours)`,
        );
      }
    } catch (err) {
      this.logger.error(
        `${trigger}: effacement des codes-barres expires - ${errorMessage(err)}`,
      );
    }
    return { import: importReport, expiredBarcodes };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
