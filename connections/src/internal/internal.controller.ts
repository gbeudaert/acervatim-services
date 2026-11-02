import { Controller, Delete, Get, Param, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { InternalGuard } from '../common/guards/internal.guard';
import {
  InternalDeleteUserData,
  InternalTokenResolution,
  InternalUserExportFragment,
} from '../common/internal/contracts';
import { OauthProvider } from '../oauth/oauth.service';
import { TokenResolverService } from '../oauth/token-resolver.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Routes internes de connections - jamais exposees par le gateway (6 de
 * architecture-microservices.md).
 */
@ApiExcludeController()
@Controller('internal')
@SkipThrottle()
@UseGuards(InternalGuard)
export class InternalController {
  constructor(
    private readonly tokenResolver: TokenResolverService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Resolution BYOT -> repli premium -> mode degrade, pour `search` (et tout service a
   * source externe).
   *
   * **C'est la seule route de la constellation qui renvoie un secret d'utilisateur en
   * clair.** Elle est donc protegee par le secret de service a service, jamais exposee par
   * le gateway, et ne rend le jeton que dans le cas `user` - `fallback` ne dit que « tu peux
   * employer ta cle serveur », il ne la transmet pas : chaque service porte les siennes.
   */
  @Get('token/:userId/:provider')
  async resolveToken(
    @Param('userId') userId: string,
    @Param('provider') provider: string,
  ): Promise<InternalTokenResolution> {
    const resolution = await this.tokenResolver.resolve(
      userId,
      provider as OauthProvider,
    );
    return resolution.source === 'user'
      ? { source: 'user', credentials: resolution.credentials }
      : { source: resolution.source };
  }

  /**
   * Participant de la saga RGPD (3.4), **idempotent**.
   *
   * Supprime les credentials locaux. Les autorisations restent actives **chez le
   * fournisseur** : Discogs et MAL ne proposent pas de revocation par l'application, et un
   * appel de revocation qui echoue ne doit pas empecher la suppression du compte. C'est une
   * limite du modele, deja vraie dans le monolithe, et l'utilisateur peut retirer
   * l'autorisation depuis son compte Discogs ou MAL.
   */
  @Delete('users/:userId/data')
  async deleteUserData(
    @Param('userId') userId: string,
  ): Promise<InternalDeleteUserData> {
    const res = await this.prisma.oauthCredential.deleteMany({
      where: { userId },
    });
    return { deleted: res.count };
  }

  /**
   * Fragment d'export RGPD.
   *
   * Les jetons sortent **chiffres**, exactement comme dans le monolithe : la cle n'est jamais
   * exfiltree. Un export RGPD doit contenir ce que nous detenons, pas ce que nous pouvons en
   * faire - livrer les jetons en clair mettrait dans un fichier telechargeable de quoi
   * usurper les comptes Discogs et MAL de l'utilisateur.
   */
  @Get('users/:userId/export')
  async exportUserData(
    @Param('userId') userId: string,
  ): Promise<InternalUserExportFragment> {
    const rows = await this.prisma.oauthCredential.findMany({
      where: { userId },
    });
    return {
      service: 'connections',
      data: {
        oauthCredentials: rows.map((r) => ({
          ...r,
          expiresAt: Number(r.expiresAt),
        })),
      },
    };
  }
}
