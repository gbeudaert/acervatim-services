import {
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { InternalGuard } from '../common/guards/internal.guard';
import {
  InternalAccess,
  InternalDeleteUserData,
  InternalUserExportFragment,
} from '../common/internal/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { CollectionAccessService } from '../sharing/collection-access.service';

/**
 * Routes internes de sharing - jamais exposees par le gateway (6 de
 * architecture-microservices.md).
 */
@ApiExcludeController()
@Controller('internal')
@SkipThrottle()
@UseGuards(InternalGuard)
export class InternalController {
  constructor(
    private readonly access: CollectionAccessService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * **La route qui rend le decoupage possible** (3.1).
   *
   * Le gateway l'appelle une fois par requete du domaine collection, et propage le resultat
   * dans le principal signe. Les services aval ne re-resolvent rien, ce qui preserve
   * l'invariant du monolithe : les statuts n'ont aucun chemin par lequel arriver du client.
   *
   * `404` = aucun acces, et c'est la reponse **nominale**, pas une erreur : le gateway la
   * traduit en `404` public. On ne dit jamais si la collection existe.
   */
  @Get('access')
  async resolveAccess(
    @Query('userId') userId: string,
    @Query('collectionId') collectionId: string,
  ): Promise<InternalAccess> {
    const access = await this.access.resolve(userId, collectionId);
    if (!access) {
      throw new NotFoundException('no access');
    }
    return access;
  }

  /**
   * Participant de la saga RGPD (3.4), **idempotent**.
   *
   * Deux roles a traiter, et ils ne se traitent pas pareil :
   *  - **membre** : ses adhesions disparaissent. Les partages des autres survivent.
   *  - **proprietaire** : ses partages sont supprimes, avec leurs entrees et leurs membres.
   *    Ici on supprime physiquement plutot que de revoquer - la revocation est un geste
   *    metier qui conserve la trace, alors qu'un compte supprime ne doit rien laisser.
   *
   * `usedCount` des partages d'autrui n'est pas decremente quand un membre part : le compteur
   * mesure les places consommees, pas les membres presents. Le decrementer rendrait une place
   * a un code deja distribue, ce que le proprietaire n'a pas demande.
   */
  @Delete('users/:userId/data')
  async deleteUserData(
    @Param('userId') userId: string,
  ): Promise<InternalDeleteUserData> {
    const owned = await this.prisma.collectionShare.findMany({
      where: { ownerUserId: userId },
      select: { id: true },
    });
    const ownedIds = owned.map((s) => s.id);

    const [memberships, shares] = await this.prisma.$transaction([
      this.prisma.collectionShareMember.deleteMany({
        where: { memberUserId: userId },
      }),
      // Les entrees et les membres partent par la cascade intra-schema de `CollectionShare`.
      this.prisma.collectionShare.deleteMany({ where: { id: { in: ownedIds } } }),
    ]);

    return { deleted: memberships.count + shares.count };
  }

  /**
   * Fragment d'export RGPD. Les cles sont **celles du monolithe** (`collectionShares`,
   * `shareMemberships`) : `identity` les aplatit dans le payload, et les renommer changerait
   * la forme d'un fichier fait pour etre relu ailleurs.
   *
   * `codeHash` est **exclu** : c'est le secret qui autorise a rejoindre, il n'a rien a faire
   * dans un fichier qui sort du serveur - et le code en clair n'existe plus nulle part de
   * toute facon.
   *
   * Le libelle de l'autre partie n'y figure jamais : chacun exporte le sien.
   */
  @Get('users/:userId/export')
  async exportUserData(
    @Param('userId') userId: string,
  ): Promise<InternalUserExportFragment> {
    const [collectionShares, shareMemberships] = await Promise.all([
      this.prisma.collectionShare.findMany({
        where: { ownerUserId: userId },
        select: {
          id: true,
          label: true,
          maxUses: true,
          usedCount: true,
          expiresAt: true,
          revokedAt: true,
          createdAt: true,
          entries: {
            select: { collectionId: true, statuses: true, collectionName: true },
          },
          members: {
            select: {
              memberUserId: true,
              redeemedAt: true,
              revokedAt: true,
            },
          },
        },
      }),
      this.prisma.collectionShareMember.findMany({
        where: { memberUserId: userId },
        select: {
          shareId: true,
          label: true,
          redeemedAt: true,
          revokedAt: true,
          share: {
            select: {
              entries: {
                select: { collectionId: true, statuses: true, collectionName: true },
              },
            },
          },
        },
      }),
    ]);

    return {
      service: 'sharing',
      data: {
        collectionShares: collectionShares.map((s) => ({
          ...s,
          expiresAt: s.expiresAt === null ? null : Number(s.expiresAt),
        })),
        shareMemberships,
      },
    };
  }
}
