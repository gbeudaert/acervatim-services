import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AdminGuard } from '../common/guards/admin.guard';
import { InternalGuard } from '../common/guards/internal.guard';
import { COLLECTION_TYPE_CODES } from '../common/internal/contracts';
import { RegistryRebuildService } from './registry-rebuild.service';
import { RegistryService } from './registry.service';

const RegistryUpsertSchema = z
  .object({
    collections: z
      .array(
        z.object({
          collectionId: z.string().uuid(),
          userId: z.string().uuid(),
          typeCode: z.enum(COLLECTION_TYPE_CODES),
        }),
      )
      .max(1000)
      .optional(),
    resources: z
      .array(
        z.object({
          resourceId: z.string().uuid(),
          kind: z.enum(['item', 'node']),
          collectionId: z.string().uuid(),
        }),
      )
      .max(1000)
      .optional(),
  })
  .strict()
  .refine((v) => Boolean(v.collections?.length || v.resources?.length), {
    message: 'au moins une collection ou une ressource',
  });

class RegistryUpsertDto extends createZodDto(RegistryUpsertSchema) {}

/**
 * Registre de routage - cote ecriture (3.3 de architecture-microservices.md).
 *
 * Hors `/v1`, hors throttler, et jamais expose vers l'exterieur : ce sont les catalogs qui
 * ecrivent ici, en synchrone, a chaque creation et suppression.
 */
@ApiExcludeController()
@Controller('internal/registry')
export class RegistryController {
  constructor(
    private readonly registry: RegistryService,
    private readonly rebuild: RegistryRebuildService,
  ) {}

  /** Enregistre ou realigne des entrees. Idempotent. */
  @Put()
  @UseGuards(InternalGuard)
  async upsert(@Body() dto: RegistryUpsertDto) {
    return this.registry.upsert(dto);
  }

  /**
   * Retire une entree - collection (avec ses ressources) ou ressource. Idempotent : un
   * catalog qui rejoue une suppression apres une coupure ne doit pas recevoir d'erreur.
   */
  @Delete(':id')
  @UseGuards(InternalGuard)
  async remove(@Param('id') id: string) {
    return this.registry.remove(id);
  }

  /**
   * Declenche une reconstruction complete. Sous `AdminGuard` et non `InternalGuard` : ce
   * n'est pas un appel de service a service mais une operation d'exploitation, longue et
   * lourde, qu'on lance en connaissance de cause. Le passage nocturne fait la meme chose
   * sans intervention.
   */
  @Post('rebuild')
  @UseGuards(AdminGuard)
  async triggerRebuild() {
    return this.rebuild.rebuild();
  }

  /** Etat des dernieres reconstructions - la mesure « 0 divergence » exigee au 4. */
  @Get('rebuild')
  @UseGuards(AdminGuard)
  async rebuildStatus() {
    return { runs: await this.rebuild.recentRuns() };
  }
}
