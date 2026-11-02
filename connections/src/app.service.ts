import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma/prisma.service';

@Injectable()
export class AppService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Liveness : le processus repond. Aucune dependance sollicitee. */
  health(): { status: string; service: string } {
    return { status: 'ok', service: 'acervatim-connections' };
  }

  /**
   * Readiness. `providers` dit quels flux sont reellement utilisables : un service sain dont
   * `DISCOGS_CONSUMER_KEY` manque repond 503 sur `/v1/oauth/discogs/start`, et le decouvrir
   * au premier utilisateur plutot qu'ici serait une perte de temps evitable.
   */
  async ready(): Promise<{
    status: string;
    db: boolean;
    credentials: number | null;
    providers: { discogs: boolean; mal: boolean };
  }> {
    let db = true;
    let credentials: number | null = null;
    try {
      credentials = await this.prisma.oauthCredential.count();
    } catch {
      db = false;
    }
    return {
      status: db ? 'ok' : 'degraded',
      db,
      credentials,
      providers: {
        discogs: Boolean(
          this.config.get<string>('DISCOGS_CONSUMER_KEY') &&
            this.config.get<string>('DISCOGS_CONSUMER_SECRET'),
        ),
        mal: Boolean(
          this.config.get<string>('MAL_CLIENT_ID') &&
            this.config.get<string>('MAL_CLIENT_SECRET'),
        ),
      },
    };
  }
}
