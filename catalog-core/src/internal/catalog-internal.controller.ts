import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  InternalCollectionOwner,
  InternalDeleteUserData,
  InternalItemCountResponse,
  InternalRegistryEntriesPage,
  InternalUserExportFragment,
  SHARE_STATUSES,
} from '../contracts';
import { CatalogInternalService } from './catalog-internal.service';

const ItemCountSchema = z
  .object({
    entries: z
      .array(
        z.object({
          collectionId: z.string().uuid(),
          // Un ensemble vide ne montre rien : accepte, il rendra simplement `0`. Le refuser
          // ferait echouer une lecture de partage sur une ligne abimee, alors que la bonne
          // reponse est « aucun item visible ».
          statuses: z.array(z.enum(SHARE_STATUSES)),
        }),
      )
      .max(500),
  })
  .strict();

class ItemCountDto extends createZodDto(ItemCountSchema) {}

/**
 * Routes internes du catalog - jamais exposees par le gateway (6 de
 * architecture-microservices.md).
 *
 * Le garde est pose par le service catalog au niveau du module : `InternalGuard` vit dans son
 * socle, que cette bibliotheque ne peut pas importer.
 */
@ApiExcludeController()
@Controller('internal')
export class CatalogInternalController {
  constructor(private readonly internal: CatalogInternalService) {}

  /** Appelee par `sharing` a la creation d'un partage (3.1). `404` = ce catalog ne sert pas. */
  @Get('collections/:id/owner')
  async collectionOwner(
    @Param('id') id: string,
  ): Promise<InternalCollectionOwner> {
    return this.internal.collectionOwner(id);
  }

  /** Appelee par `sharing` a chaque lecture de partage recu (3.2). Un appel, N entrees. */
  @Post('items/count')
  async countItems(
    @Body() dto: ItemCountDto,
  ): Promise<InternalItemCountResponse> {
    return this.internal.countItems(dto.entries);
  }

  /** Appelee par le job de reparation du registre du gateway (3.3). */
  @Get('registry/entries')
  async registryEntries(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<InternalRegistryEntriesPage> {
    return this.internal.registryEntries(cursor, Number(limit) || 500);
  }

  /** Participant de la saga RGPD (3.4), idempotent. */
  @Delete('users/:userId/data')
  async deleteUserData(
    @Param('userId') userId: string,
  ): Promise<InternalDeleteUserData> {
    return this.internal.deleteUserData(userId);
  }

  /** Fragment d'export RGPD (3.4). */
  @Get('users/:userId/export')
  async exportUserData(
    @Param('userId') userId: string,
  ): Promise<InternalUserExportFragment> {
    return {
      service: 'catalog',
      data: await this.internal.exportUserData(userId),
    };
  }
}
