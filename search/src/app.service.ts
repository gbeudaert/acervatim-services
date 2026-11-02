import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisHealthService } from './common/redis/redis-health.service';
import { PrismaService } from './prisma/prisma.service';

@Injectable()
export class AppService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redisHealth: RedisHealthService,
    private readonly config: ConfigService,
  ) {}

  /** Liveness : le processus repond. Aucune dependance sollicitee. */
  health(): { status: string; service: string } {
    return { status: 'ok', service: 'acervatim-search' };
  }

  /**
   * Readiness.
   *
   * Redis est ici **vital**, contrairement aux autres services : toutes les sources externes
   * passent par une file BullMQ, et sans Redis le chemin interactif n'a plus que le cache a
   * servir. On le declare donc `degraded`, ce qui est exact - la recherche fonctionne encore,
   * en lecture de cache seulement.
   *
   * `sources` dit lesquelles sont configurees : une source sans cle serveur ne repond qu'aux
   * utilisateurs ayant connecte la leur, et le decouvrir au premier utilisateur plutot qu'ici
   * serait une perte de temps evitable.
   */
  async ready(): Promise<{
    status: string;
    db: boolean;
    redis: boolean;
    cachedEntries: number | null;
    sources: Record<string, boolean>;
  }> {
    let db = true;
    let cachedEntries: number | null = null;
    try {
      cachedEntries = await this.prisma.apiCache.count();
    } catch {
      db = false;
    }
    const redis = this.redisHealth.isAvailable();
    return {
      status: db && redis ? 'ok' : 'degraded',
      db,
      redis,
      cachedEntries,
      sources: {
        discogs: Boolean(
          this.config.get<string>('DISCOGS_ACERVATIM_TOKEN') ??
            this.config.get<string>('DISCOGS_CONSUMER_KEY'),
        ),
        mal: Boolean(this.config.get<string>('MAL_CLIENT_ID')),
        tmdb: Boolean(this.config.get<string>('TMDB_API_KEY')),
        // BnF est un service public sans cle : toujours disponible.
        bnf: true,
        // Google Books fonctionne sans cle, avec un quota reduit.
        googleBooks: true,
      },
    };
  }
}
