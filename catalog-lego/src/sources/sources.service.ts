import { BadRequestException, Injectable } from '@nestjs/common';
import { AesService } from '../common/crypto/aes.service';
import { PrismaService } from '../prisma/prisma.service';
import { LegoProvider } from '../common/sources/token-resolver.port';

const SUPPORTED: readonly LegoProvider[] = ['rebrickable'] as const;

@Injectable()
export class SourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aes: AesService,
  ) {}

  /**
   * Brickset est volontairement absent de la liste : sa cle est une ressource **du service**
   * (moissonnage hors ligne), pas une source qu'un utilisateur connecte. Accepter un BYOT
   * Brickset donnerait a croire qu'il ameliore le scan, alors que le scan lit l'index local.
   */
  assertProvider(raw: string): LegoProvider {
    const found = SUPPORTED.find((p) => p === raw);
    if (!found) {
      throw new BadRequestException(
        `Unsupported provider: ${raw} (supported: ${SUPPORTED.join(', ')})`,
      );
    }
    return found;
  }

  async listConnected(
    userId: string,
  ): Promise<{ provider: string; connectedAt: string }[]> {
    const rows = await this.prisma.sourceCredential.findMany({
      where: { userId },
      select: { provider: true, createdAt: true },
    });
    return rows.map((r) => ({
      provider: r.provider,
      connectedAt: r.createdAt.toISOString(),
    }));
  }

  async setToken(
    userId: string,
    provider: LegoProvider,
    token: string,
  ): Promise<void> {
    const encryptedKey = this.aes.encrypt(token);
    await this.prisma.sourceCredential.upsert({
      where: { userId_provider: { userId, provider } },
      create: { userId, provider, encryptedKey },
      update: { encryptedKey },
    });
  }

  async revokeToken(userId: string, provider: LegoProvider): Promise<void> {
    await this.prisma.sourceCredential
      .delete({ where: { userId_provider: { userId, provider } } })
      .catch(() => undefined);
  }

  /** Participant de la saga RGPD : tout ce que ce service detient sur un utilisateur. */
  async deleteUserData(userId: string): Promise<number> {
    const res = await this.prisma.sourceCredential.deleteMany({
      where: { userId },
    });
    return res.count;
  }

  async exportUserData(
    userId: string,
  ): Promise<{
    connectedSources: { provider: string; connectedAt: string }[];
  }> {
    return { connectedSources: await this.listConnected(userId) };
  }
}
