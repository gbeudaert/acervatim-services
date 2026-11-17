import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ReadinessStatus,
  readinessStatus,
  withDeadline,
} from './common/health/readiness';
import { PrismaService } from './prisma/prisma.service';

@Injectable()
export class AppService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Liveness : le processus repond. Aucune dependance sollicitee. */
  health(): { status: string; service: string } {
    return { status: 'ok', service: 'acervatim-billing' };
  }

  /**
   * Readiness. Base injoignable ou muette au-dela du delai : `unavailable`, que le
   * controleur traduit en `503`.
   *
   * `googlePlay` est expose parce qu'un billing techniquement sain mais non configure
   * repond `503` a toute verification d'achat : c'est une information d'exploitation, pas
   * un motif d'echec - le statut premium des grants continue de fonctionner sans Google
   * Play.
   */
  async ready(): Promise<{
    status: ReadinessStatus;
    db: boolean;
    subscriptions: number | null;
    googlePlay: { configured: boolean; pubsub: boolean };
  }> {
    let db = true;
    let subscriptions: number | null = null;
    try {
      subscriptions = await withDeadline(this.prisma.subscription.count());
    } catch {
      db = false;
    }
    return {
      status: readinessStatus(db),
      db,
      subscriptions,
      googlePlay: {
        configured: Boolean(
          this.config.get<string>('GOOGLE_PLAY_PACKAGE_NAME') &&
            this.config.get<string>('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'),
        ),
        pubsub: Boolean(
          this.config.get<string>('GOOGLE_PUBSUB_SA_EMAIL') &&
            this.config.get<string>('GOOGLE_PUBSUB_AUDIENCE'),
        ),
      },
    };
  }
}
