import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ReadinessStatus,
  readinessStatus,
  withDeadline,
} from './common/health/readiness';
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
   * Readiness. Base injoignable ou muette au-dela du delai : `unavailable`, que le
   * controleur traduit en `503`.
   *
   * Redis pese ici plus qu'ailleurs : toutes les sources externes passent par une file
   * BullMQ, et sans lui le chemin interactif n'a plus que le cache a servir - un appel hors
   * cache repond `503` de lui-meme (circuit-breaker). Il reste pourtant une dependance
   * secondaire, d'ou `degraded` (et un `200`) : le cache, `edition-mapping` (cache seul) et
   * la route RGPD `/internal/users/:id/data` repondent sans lui, et une sonde en `503` les
   * declarerait perdus avec le reste. L'etat de Redis vient d'un drapeau tenu par les
   * evenements de connexion : le lire ne peut pas suspendre la sonde.
   *
   * `sources` dit lesquelles sont configurees : une source sans cle serveur ne repond qu'aux
   * utilisateurs ayant connecte la leur, et le decouvrir au premier utilisateur plutot qu'ici
   * serait une perte de temps evitable.
   */
  async ready(): Promise<{
    status: ReadinessStatus;
    db: boolean;
    redis: boolean;
    cachedEntries: number | null;
    sources: Record<string, boolean>;
  }> {
    let db = true;
    let cachedEntries: number | null = null;
    try {
      cachedEntries = await withDeadline(this.prisma.apiCache.count());
    } catch {
      db = false;
    }
    const redis = this.redisHealth.isAvailable();
    return {
      status: readinessStatus(db, redis),
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
