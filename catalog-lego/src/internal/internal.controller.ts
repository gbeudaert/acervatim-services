import { Controller, Delete, Get, Param, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { AdminGuard } from '../common/guards/admin.guard';
import { SourcesService } from '../sources/sources.service';

/**
 * Routes internes du service - jamais exposees par le gateway vers l'exterieur (6 de
 * ../acervatim-docs/agent/backend/architecture-microservices.md).
 *
 * Ce service participe a la **saga RGPD** decrite en 3.4 : la cascade Prisma ne franchit pas
 * une frontiere de schema, donc `identity` orchestre la suppression et interroge chaque
 * service. Les deux operations sont **idempotentes** - c'est la condition pour que le rejeu
 * d'un job non termine soit sans danger, et donc pour que la saga puisse etre reprise.
 *
 * Aujourd'hui ce service ne detient qu'une donnee rattachee a un utilisateur : sa cle API
 * personnelle. L'index et le cache sont des donnees publiques, sans `userId`.
 */
@ApiExcludeController()
@Controller('internal')
@UseGuards(AdminGuard)
@SkipThrottle()
export class InternalController {
  constructor(private readonly sources: SourcesService) {}

  @Delete('users/:userId/data')
  async deleteUserData(
    @Param('userId') userId: string,
  ): Promise<{ deleted: number }> {
    return { deleted: await this.sources.deleteUserData(userId) };
  }

  @Get('users/:userId/export')
  async exportUserData(@Param('userId') userId: string): Promise<unknown> {
    return this.sources.exportUserData(userId);
  }
}
