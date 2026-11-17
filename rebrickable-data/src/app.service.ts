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
    return { status: 'ok', service: 'acervatim-rebrickable-data' };
  }

  /**
   * Readiness.
   *
   * La base est vitale : toutes les lectures `/internal/*` en viennent. Injoignable ou
   * muette au-dela du delai : `unavailable`, que le controleur traduit en `503`. Redis ne
   * sert qu'a la file Brickset - sans lui, le catalogue est servi mais le moissonnage des
   * codes-barres ne part pas, d'ou `degraded` (et un `200`) plutot qu'une panne.
   *
   * `sets` a `0` signifie qu'aucun import n'a encore abouti : le service repond, mais vide.
   */
  async ready(): Promise<{
    status: ReadinessStatus;
    db: boolean;
    redis: boolean;
    sets: number | null;
    brickset: boolean;
  }> {
    let db = true;
    let sets: number | null = null;
    try {
      sets = await withDeadline(this.prisma.legoSet.count());
    } catch {
      db = false;
    }
    const redis = this.redisHealth.isAvailable();
    return {
      status: readinessStatus(db, redis),
      db,
      redis,
      sets,
      brickset: Boolean(this.config.get<string>('BRICKSET_API_KEY')),
    };
  }
}
