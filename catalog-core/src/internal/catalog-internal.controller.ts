import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  COLLECTION_TYPE_CODES,
  InternalCollectionOwner,
  InternalDeleteUserData,
  InternalItemCountResponse,
  InternalNodesPage,
  InternalRegistryEntriesPage,
  InternalUserExportFragment,
  InternalUserNodes,
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

const NodesScopeSchema = z.object({
  typeCode: z.enum(COLLECTION_TYPE_CODES),
  level: z.string().min(1).max(32),
});

class UserNodesQuery extends createZodDto(NodesScopeSchema.strict()) {}

class NodesPageQuery extends createZodDto(
  NodesScopeSchema.extend({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(500),
  }).strict(),
) {}

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

  /** Appelee par le rattrapage hebdomadaire de `search` : noeuds d'un type et d'un niveau. */
  @Get('nodes')
  async nodesPage(@Query() q: NodesPageQuery): Promise<InternalNodesPage> {
    return this.internal.nodesPage(q.typeCode, q.level, q.cursor, q.limit);
  }

  /** Appelee par `search` pour `GET /v1/series-updates` : noeuds d'un compte + volumes. */
  @Get('users/:userId/nodes')
  async userNodes(
    @Param('userId') userId: string,
    @Query() q: UserNodesQuery,
  ): Promise<InternalUserNodes> {
    return this.internal.userNodes(userId, q.typeCode, q.level);
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
