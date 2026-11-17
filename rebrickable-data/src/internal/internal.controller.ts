import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { BricksetLookupService } from '../brickset/brickset-lookup.service';
import { CatalogService } from '../catalog/catalog.service';
import { InternalGuard } from '../common/guards/internal.guard';
import {
  InternalLegoBarcodeLookup,
  InternalLegoSet,
  InternalLegoSetPage,
  InternalLegoTheme,
} from '../common/internal/contracts';

export const SetsQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200).optional(),
    // Slug de theme : "technic", "star-wars". Resolu vers le theme ET sa descendance.
    theme: z.string().min(1).max(64).optional(),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const BarcodeParamsSchema = z.object({
  // EAN-13 / UPC-A, avec ou sans tirets ni espaces : 6 a 20 CHIFFRES, separateurs non comptes.
  // La normalisation et l'equivalence UPC/EAN ont lieu dans `barcode.ts`, pas ici.
  code: z
    .string()
    .max(40)
    .regex(/^[0-9\s-]+$/, 'code must contain only digits, spaces and dashes')
    .refine((c) => {
      const digits = c.replace(/\D/g, '').length;
      return digits >= 6 && digits <= 20;
    }, 'code must be 6-20 digits'),
});

export const SetParamsSchema = z.object({
  setNum: z.string().min(1).max(32),
});

export const ThemesQuerySchema = z
  .object({
    parent: z.string().min(1).max(64).optional(),
  })
  .strict();

export class SetsQueryDto extends createZodDto(SetsQuerySchema) {}
export class BarcodeParamsDto extends createZodDto(BarcodeParamsSchema) {}
export class SetParamsDto extends createZodDto(SetParamsSchema) {}
export class ThemesQueryDto extends createZodDto(ThemesQuerySchema) {}

/**
 * Routes internes de rebrickable-data - jamais exposees par le gateway. Ce sont les seules
 * lectures du catalogue. Toutes sont locales, sauf le scan d'un code absent du cache, qui
 * appelle Brickset une fois (`BricksetLookupService`). Aucune ne declenche d'import.
 */
@ApiExcludeController()
@Controller('internal')
@SkipThrottle()
@UseGuards(InternalGuard)
export class InternalController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly barcodes: BricksetLookupService,
  ) {}

  /** Recherche : numero (prefixe) ou nom (sous-chaine), filtre par theme et sa descendance. */
  @Get('sets')
  async searchSets(@Query() query: SetsQueryDto): Promise<InternalLegoSetPage> {
    return this.catalog.searchSets(query);
  }

  /**
   * Scan : toutes les references portant ce code, 20 au plus, et l'issue de la recherche. Pour
   * un code absent du cache, Brickset est appele une fois : la reponse peut prendre quelques
   * secondes (`BRICKSET_SCAN_WAIT_MS`).
   */
  @Get('sets/by-barcode/:code')
  async byBarcode(
    @Param() params: BarcodeParamsDto,
  ): Promise<InternalLegoBarcodeLookup> {
    return this.barcodes.lookup(params.code);
  }

  @Get('sets/:setNum')
  async getSet(@Param() params: SetParamsDto): Promise<InternalLegoSet> {
    return this.catalog.getSet(params.setNum);
  }

  /** `parent` absent : themes de tete. Sinon les enfants directs du slug donne. */
  @Get('themes')
  async listThemes(
    @Query() query: ThemesQueryDto,
  ): Promise<{ items: InternalLegoTheme[] }> {
    return { items: await this.catalog.listThemes(query.parent) };
  }
}
