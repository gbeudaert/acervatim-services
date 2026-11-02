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
import { AttachItemSourceDto } from './dto/attach-source.dto';
import { CreateItemDto } from './dto/create-item.dto';
import { ListItemsQueryDto } from './dto/list-items.query';
import { UpdateItemDto } from './dto/update-item.dto';
import { ItemsService } from './items.service';

/**
 * `/v1/collections/:id/items` et `/v1/items/:id` - identiques au contrat du monolithe.
 *
 * **Aucun garde premium ici** : les trois gardes du monolithe sont remontees au gateway (3.6).
 * `CollectionAccessGuard` ne fait plus que lire l'acces deja resolu et signe, et rendre `404`
 * si la ressource n'existe pas dans ce catalog.
 */
@ApiTags('items')
@ApiBearerAuth()
@Controller()
@UseGuards(CollectionAccessGuard)
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Post('collections/:collectionId/items')
  @CollectionRef('collection', 'collectionId')
  async create(
    @CurrentUserId() userId: string,
    @Param('collectionId', new ParseUUIDPipe()) collectionId: string,
    @Body() dto: CreateItemDto,
  ) {
    return this.items.create(userId, collectionId, dto);
  }

  @Get('collections/:collectionId/items')
  @CollectionRef('collection', 'collectionId')
  async list(
    @CurrentCollectionAccess() access: CollectionAccess,
    // Non consomme (deja dans `access`), mais le pipe doit rester : sans lui un
    // identifiant malforme ne serait plus un 400, le guard le laissant passer.
    @Param('collectionId', new ParseUUIDPipe()) _collectionId: string,
    @Query() query: ListItemsQueryDto,
  ) {
    return this.items.list(access, query);
  }

  @Get('items/:id')
  @CollectionRef('item', 'id')
  async findOne(
    @CurrentCollectionAccess() access: CollectionAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.items.findOne(access, id);
  }

  @Get('items/:id/sources')
  @CollectionRef('item', 'id')
  async sources(
    @CurrentCollectionAccess() access: CollectionAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.items.getSources(access, id);
  }

  @Post('items/:id/sources')
  @CollectionRef('item', 'id')
  async attachSource(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AttachItemSourceDto,
  ) {
    return this.items.attachSource(userId, id, dto);
  }

  @Patch('items/:id')
  @CollectionRef('item', 'id')
  async update(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateItemDto,
  ) {
    return this.items.update(userId, id, dto);
  }

  @Delete('items/:id')
  @CollectionRef('item', 'id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.items.remove(userId, id);
  }
}
