import {
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { ImportRun } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  BricksetHarvestService,
  HarvestReport,
} from '../brickset/brickset-harvest.service';
import { BricksetService } from '../brickset/brickset.service';
import { CatalogService } from '../catalog/catalog.service';
import { AdminGuard } from '../common/guards/admin.guard';
import {
  ImportReport,
  RebrickableCsvService,
} from '../import/rebrickable-csv.service';

export const ImportQuerySchema = z
  .object({
    // `?force` (nu, forme documentee), `?force=true` ou `?force=1`, casse indifferente, passent
    // outre le controle `Last-Modified`. `false` / `0` / absent : import conditionnel.
    force: z
      .preprocess(
        (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
        z.enum(['', 'true', '1', 'false', '0']).optional(),
      )
      .transform((v) => v === '' || v === 'true' || v === '1'),
  })
  .strict();

export class ImportQueryDto extends createZodDto(ImportQuerySchema) {}

/**
 * Exploitation. Hors prefixe `/v1` (cf. `main.ts`), protegee par `ADMIN_API_TOKEN`. Ces routes
 * existent parce que l'alimentation n'est pas observable autrement : sous quota journalier,
 * savoir ou en est la campagne Brickset est la difference entre « l'index se remplit » et
 * « l'index est bloque depuis six jours ».
 */
@ApiExcludeController()
@Controller('admin')
@UseGuards(AdminGuard)
@SkipThrottle()
export class AdminController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly importer: RebrickableCsvService,
    private readonly harvest: BricksetHarvestService,
    private readonly brickset: BricksetService,
  ) {}

  @Get('status')
  async status(): Promise<{
    counts: Awaited<ReturnType<CatalogService['counts']>>;
    brickset: { configured: boolean; used: number; budget: number };
    runs: ImportRun[];
  }> {
    const [counts, budget, runs] = await Promise.all([
      this.catalog.counts(),
      this.brickset.budgetStatus(),
      this.harvest.lastRuns(10),
    ]);
    return {
      counts,
      brickset: { configured: this.brickset.isConfigured(), ...budget },
      runs,
    };
  }

  /** Import des CSV sans attendre 03:00 UTC. Rattache a l'import en cours s'il y en a un. */
  @Post('import/rebrickable')
  @HttpCode(200)
  async importRebrickable(
    @Query() query: ImportQueryDto,
  ): Promise<ImportReport> {
    return this.importer.run({ force: query.force });
  }

  /** Campagne Brickset sans attendre 03:00 UTC, dans la limite du budget du jour. */
  @Post('harvest/brickset')
  @HttpCode(200)
  async harvestBrickset(): Promise<HarvestReport> {
    return this.harvest.run();
  }
}
