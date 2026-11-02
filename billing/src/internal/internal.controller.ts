import { Controller, Delete, Get, Param, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { InternalGuard } from '../common/guards/internal.guard';
import {
  InternalDeleteUserData,
  InternalPremium,
  InternalUserExportFragment,
} from '../common/internal/contracts';
import { PremiumService } from '../premium/premium.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Routes internes de billing - jamais exposees par le gateway (6 de
 * architecture-microservices.md).
 */
@ApiExcludeController()
@Controller('internal')
@SkipThrottle()
@UseGuards(InternalGuard)
export class InternalController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly premium: PremiumService,
  ) {}

  /**
   * **La route la plus appelee de la constellation** : le gateway l'interroge sur chaque
   * requete du domaine collection (avec un cache de 60 s), et `sharing` pour connaitre le
   * statut d'un proprietaire. Elle doit rester une lecture de deux lignes et rien d'autre.
   */
  @Get('premium/:userId')
  async premiumStatus(
    @Param('userId') userId: string,
  ): Promise<InternalPremium> {
    const status = await this.premium.getStatus(userId);
    return {
      premium: status.isPremium,
      source: status.source,
      expiresAt: status.expiresAt,
    };
  }

  /**
   * Participant de la saga RGPD (3.4), **idempotent**.
   *
   * L'abonnement Google Play est supprime de notre base ; il continue d'exister chez Google,
   * ou seul l'utilisateur peut le resilier. Effacer notre ligne ne resilie donc rien - c'est
   * une limite du modele, pas un oubli, et elle vaut aussi pour le monolithe : la
   * suppression du compte n'a jamais rembourse ni annule quoi que ce soit.
   */
  @Delete('users/:userId/data')
  async deleteUserData(
    @Param('userId') userId: string,
  ): Promise<InternalDeleteUserData> {
    const [subscription, grant, redemptions] = await this.prisma.$transaction([
      this.prisma.subscription.deleteMany({ where: { userId } }),
      this.prisma.premiumGrant.deleteMany({ where: { userId } }),
      this.prisma.invitationRedemption.deleteMany({ where: { userId } }),
    ]);
    return {
      deleted: subscription.count + grant.count + redemptions.count,
    };
  }

  /**
   * Fragment d'export RGPD. Les cles sont **celles du monolithe** (`subscription`,
   * `premiumGrant`, `invitationRedemptions`) : `identity` les aplatit dans le payload, et
   * les renommer changerait la forme d'un fichier fait pour etre relu ailleurs.
   *
   * `expiresAt` est un `BigInt` cote Prisma ; il est converti en nombre ici plutot que de
   * compter sur le remplaceur JSON d'`identity` - un fragment doit etre serialisable seul.
   */
  @Get('users/:userId/export')
  async exportUserData(
    @Param('userId') userId: string,
  ): Promise<InternalUserExportFragment> {
    const [subscription, premiumGrant, invitationRedemptions] =
      await Promise.all([
        this.prisma.subscription.findUnique({ where: { userId } }),
        this.prisma.premiumGrant.findUnique({ where: { userId } }),
        this.prisma.invitationRedemption.findMany({ where: { userId } }),
      ]);

    return {
      service: 'billing',
      data: {
        subscription: subscription
          ? { ...subscription, expiresAt: Number(subscription.expiresAt) }
          : null,
        premiumGrant: premiumGrant
          ? {
              ...premiumGrant,
              expiresAt:
                premiumGrant.expiresAt === null
                  ? null
                  : Number(premiumGrant.expiresAt),
            }
          : null,
        invitationRedemptions,
      },
    };
  }
}
