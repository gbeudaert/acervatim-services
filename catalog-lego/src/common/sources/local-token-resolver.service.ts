import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AesService } from '../crypto/aes.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  LegoProvider,
  ResolvedToken,
  TokenResolverPort,
} from './token-resolver.port';

const SERVER_KEY_ENV: Record<LegoProvider, string> = {
  rebrickable: 'REBRICKABLE_API_KEY',
  brickset: 'BRICKSET_API_KEY',
};

/**
 * Implementation autonome du port : credentials en base locale, cle serveur en env.
 * A remplacer par un client HTTP vers `connections` quand ce service existera (M4).
 */
@Injectable()
export class LocalTokenResolver extends TokenResolverPort {
  private readonly logger = new Logger(LocalTokenResolver.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aes: AesService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async resolve(
    userId: string,
    provider: LegoProvider,
    premium: boolean,
  ): Promise<ResolvedToken | null> {
    const row = await this.prisma.sourceCredential.findUnique({
      where: { userId_provider: { userId, provider } },
    });
    if (row) {
      try {
        return { key: this.aes.decrypt(row.encryptedKey), origin: 'user' };
      } catch {
        // Cle indechiffrable (rotation ratee, row corrompue) : on ne bloque pas
        // l'utilisateur, on retombe sur le chemin premium/degrade.
        this.logger.warn(
          `credential ${provider} indechiffrable pour user=${userId.slice(0, 8)}...`,
        );
      }
    }

    if (!premium) return null;

    const serverKey = this.config.get<string>(SERVER_KEY_ENV[provider]);
    return serverKey ? { key: serverKey, origin: 'acervatim' } : null;
  }
}
