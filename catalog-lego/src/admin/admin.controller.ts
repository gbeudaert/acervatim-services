import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiCacheService } from '../common/cache/api-cache.service';
import { AdminGuard } from '../common/guards/admin.guard';
import { BricksetService } from '../common/sources/brickset/brickset.service';
import {
  HarvestReport,
  HarvestService,
} from '../common/sources/set-index/harvest.service';
import { SetIndexService } from '../common/sources/set-index/set-index.service';
import { ThemeSyncService } from '../common/sources/set-index/theme-sync.service';

/**
 * Exploitation de l'index. Ces routes existent parce que le moissonnage n'est pas observable
 * autrement : sous quota journalier, savoir ou en est la campagne et combien d'appels restent
 * est la difference entre « l'index se remplit » et « l'index est bloque depuis six jours ».
 */
@ApiExcludeController()
@Controller('admin/lego')
@UseGuards(AdminGuard)
@SkipThrottle()
export class AdminController {
  constructor(
    private readonly index: SetIndexService,
    private readonly harvest: HarvestService,
    private readonly themes: ThemeSyncService,
    private readonly brickset: BricksetService,
    private readonly cache: ApiCacheService,
  ) {}

  @Get('index')
  async status(): Promise<unknown> {
    const [counts, budget, runs] = await Promise.all([
      this.index.count(),
      this.brickset.budgetStatus(),
      this.harvest.lastRuns(),
    ]);
    return {
      sets: counts,
      themes: this.themes.topLevel().length,
      brickset: { configured: this.brickset.isConfigured(), ...budget },
      cache: this.cache.stats(),
      runs,
    };
  }

  /** Relance le moissonnage Rebrickable (catalogue) sans attendre le passage nocturne. */
  @Post('index/rebrickable')
  async runRebrickable(): Promise<HarvestReport> {
    return this.harvest.harvestRebrickable();
  }

  /** Relance le moissonnage Brickset (codes-barres), dans la limite du budget du jour. */
  @Post('index/brickset')
  async runBrickset(): Promise<HarvestReport> {
    return this.harvest.harvestBrickset();
  }

  @Post('themes/sync')
  async syncThemes(): Promise<{ themes: number }> {
    const themes = await this.themes.sync({
      userId: 'system',
      premium: true,
    });
    return { themes };
  }
}
