import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { InternalGuard } from '../common/guards/internal.guard';
import {
  InternalDeleteUserData,
  InternalSourceSnapshotResponse,
  InternalUserExportFragment,
} from '../common/internal/contracts';
import { SourceSnapshotService } from '../sources/source-snapshot.service';

const SnapshotSchema = z
  .object({
    userId: z.string().uuid(),
    provider: z.string().min(1).max(32),
    externalId: z.string().min(1).max(255),
  })
  .strict();

class SnapshotDto extends createZodDto(SnapshotSchema) {}

/**
 * Routes internes de search - jamais exposees par le gateway (6 de
 * architecture-microservices.md).
 */
@ApiExcludeController()
@Controller('internal')
@SkipThrottle()
@UseGuards(InternalGuard)
export class InternalController {
  constructor(private readonly snapshots: SourceSnapshotService) {}

  /**
   * Pre-remplit la verite curee d'un item ou d'un noeud a partir d'une reference provider.
   * Appelee par les catalogs a l'attachement d'une source.
   *
   * `rawData: null` signifie « provider sans adapter » (`bnf`, `mangadex`, `isbn`) : la
   * reference est conservee telle quelle. Le catalog s'en sert pour trancher un cas du
   * contrat V1 - une source sans adapter **et** sans `unifiedData` est un `400`, parce que
   * rien ne decrirait la ressource.
   */
  @Post('sources/snapshot')
  async snapshot(
    @Body() dto: SnapshotDto,
  ): Promise<InternalSourceSnapshotResponse> {
    return this.snapshots.snapshot(dto.provider, dto.externalId, dto.userId);
  }

  /**
   * Participant de la saga RGPD (3.4), **idempotent** - et sans effet, ce qui est le point
   * interessant.
   *
   * Ce service ne detient **aucune donnee rattachee a un utilisateur**. `api_cache` contient
   * des reponses de catalogues publics (BnF, Google Books, MangaDex, Discogs, MAL, TMDB),
   * dont les cles ne portent volontairement pas de `userId` - c'est ce qui permet a un hit
   * d'un utilisateur de servir a un autre, et au mode degrade de fonctionner. Les jetons
   * appartiennent a `connections`, les jobs d'import vivent dans Redis avec un identifiant
   * derive du titre, pas du demandeur.
   *
   * La route existe donc pour la symetrie du contrat : `identity` interroge tous les
   * participants declares, et un participant qui repondrait 404 ferait echouer une saga
   * pour rien.
   */
  @Delete('users/:userId/data')
  async deleteUserData(
    @Param('userId') _userId: string,
  ): Promise<InternalDeleteUserData> {
    return { deleted: 0 };
  }

  /** Fragment d'export RGPD : vide, pour la meme raison. */
  @Get('users/:userId/export')
  async exportUserData(
    @Param('userId') _userId: string,
  ): Promise<InternalUserExportFragment> {
    return { service: 'search', data: {} };
  }
}
