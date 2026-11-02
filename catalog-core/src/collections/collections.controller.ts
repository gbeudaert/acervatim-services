import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CollectionAccess, CurrentCollectionAccess } from '../access';
import {
  CollectionAccessGuard,
  CollectionRef,
} from '../collection-access.guard';
import { CurrentUserId } from '../current-user-id.decorator';
import { CollectionsService } from './collections.service';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { ListCollectionsQueryDto } from './dto/list-collections.query';
import { UpdateCollectionDto } from './dto/update-collection.dto';

/**
 * `/v1/collections` - identique au contrat du monolithe.
 *
 * **Aucun garde premium ici.** Les trois gardes du monolithe (`PremiumGuard`,
 * `CollectionPremiumGuard`, `CollectionWriteGuard`) sont remontees au gateway (3.6), qui
 * interroge `billing` une fois, avec un cache, plutot que chaque service a chaque requete.
 * Quand une requete arrive ici, le droit est deja tranche et signe.
 *
 * `PrincipalGuard` est pose au niveau du module par le service catalog : il est defini dans
 * son socle, que cette bibliotheque ne peut pas importer.
 */
@ApiTags('collections')
@ApiBearerAuth()
@Controller('collections')
@UseGuards(CollectionAccessGuard)
export class CollectionsController {
  constructor(private readonly collections: CollectionsService) {}

  @Post()
  async create(
    @CurrentUserId() userId: string,
    @Body() dto: CreateCollectionDto,
  ) {
    return this.collections.create(userId, dto);
  }

  @Get()
  async list(
    @CurrentUserId() userId: string,
    @Query() query: ListCollectionsQueryDto,
  ) {
    return this.collections.list(userId, query);
  }

  /**
   * `id` n'est pas consomme - il est deja dans `access` - mais le `ParseUUIDPipe` reste : sans
   * lui, un identifiant malforme ne serait plus refuse en `400`, le garde le laissant passer
   * sans resoudre.
   */
  @Get(':id')
  @CollectionRef('collection', 'id')
  async findOne(
    @CurrentCollectionAccess() access: CollectionAccess,
    @Param('id', new ParseUUIDPipe()) _id: string,
  ) {
    return this.collections.findOne(access);
  }

  @Patch(':id')
  @CollectionRef('collection', 'id')
  async update(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCollectionDto,
  ) {
    return this.collections.update(userId, id, dto);
  }

  @Delete(':id')
  @CollectionRef('collection', 'id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.collections.remove(userId, id);
  }
}
