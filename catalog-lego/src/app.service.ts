import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { RedisHealthService } from './common/redis/redis-health.service';
import { SetIndexService } from './common/sources/set-index/set-index.service';

@Injectable()
export class AppService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redisHealth: RedisHealthService,
    private readonly index: SetIndexService,
  ) {}

  /** Liveness : le processus repond. Aucune dependance sollicitee. */
  health(): { status: string; service: string } {
    return { status: 'ok', service: 'acervatim-lego' };
  }

  /**
   * Readiness : base joignable, Redis joignable, index dimensionne. `indexed` est expose parce
   * qu'un service techniquement sain mais a index vide ne sait pas repondre a un scan - c'est
   * une information d'exploitation, pas un motif d'echec.
   */
  async ready(): Promise<{
    status: string;
    db: boolean;
    redis: boolean;
    indexed: { total: number; withBarcode: number } | null;
  }> {
    let db = true;
    let indexed: { total: number; withBarcode: number } | null = null;
    try {
      indexed = await this.index.count();
    } catch {
      db = false;
    }
    const redis = this.redisHealth.isAvailable();
    return {
      status: db && redis ? 'ok' : 'degraded',
      db,
      redis,
      indexed,
    };
  }
}
