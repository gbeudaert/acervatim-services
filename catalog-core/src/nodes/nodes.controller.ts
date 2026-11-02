import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { CollectionAccess, CurrentCollectionAccess } from '../access';
import {
  CollectionAccessGuard,
  CollectionRef,
} from '../collection-access.guard';
import { CurrentUserId } from '../current-user-id.decorator';
import { AttachNodeSourceDto } from './dto/attach-source.dto';
import { CreateNodeDto } from './dto/create-node.dto';
import { ListNodesQueryDto } from './dto/list-nodes.query';
import { UpdateNodeDto } from './dto/update-node.dto';
import { NodesService } from './nodes.service';

/**
 * `/v1/collections/:id/nodes` et `/v1/nodes/:id` - identiques au contrat du monolithe.
 * Gardes premium remontees au gateway (3.6), comme pour les items.
 */
@ApiTags('nodes')
@ApiBearerAuth()
@Controller()
@UseGuards(CollectionAccessGuard)
export class NodesController {
  constructor(private readonly nodes: NodesService) {}

  @Post('collections/:collectionId/nodes')
  @CollectionRef('collection', 'collectionId')
  async create(
    @CurrentUserId() userId: string,
    @Param('collectionId', new ParseUUIDPipe()) collectionId: string,
    @Body() dto: CreateNodeDto,
  ) {
    return this.nodes.create(userId, collectionId, dto);
  }

  @Get('collections/:collectionId/nodes')
  @CollectionRef('collection', 'collectionId')
  async list(
    @CurrentCollectionAccess() access: CollectionAccess,
    // Non consomme (deja dans `access`), mais le pipe doit rester : sans lui un
    // identifiant malforme ne serait plus un 400, le guard le laissant passer.
    @Param('collectionId', new ParseUUIDPipe()) _collectionId: string,
    @Query() query: ListNodesQueryDto,
  ) {
    return this.nodes.list(access, query);
  }

  @Get('nodes/:id')
  @CollectionRef('node', 'id')
  async findOne(
    @CurrentCollectionAccess() access: CollectionAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.nodes.findOne(access, id);
  }

  @Get('nodes/:id/sources')
  @CollectionRef('node', 'id')
  async sources(
    @CurrentCollectionAccess() access: CollectionAccess,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.nodes.getSources(access, id);
  }

  @Patch('nodes/:id')
  @CollectionRef('node', 'id')
  async update(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateNodeDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.nodes.update(userId, id, dto);
    if (result === null) {
      // Purge (isWishlist=false & vide) → 204 No Content.
      res.status(HttpStatus.NO_CONTENT);
      return undefined;
    }
    return result;
  }

  @Post('nodes/:id/sources')
  @CollectionRef('node', 'id')
  async attachSource(
    @CurrentUserId() userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AttachNodeSourceDto,
  ) {
    return this.nodes.attachSource(userId, id, dto);
  }
}
