import { Injectable } from '@nestjs/common';
import {
  ReadinessStatus,
  readinessStatus,
  withDeadline,
} from './common/health/readiness';
import { PrismaService } from './prisma/prisma.service';
import { DeletionSagaService } from './saga/deletion-saga.service';

@Injectable()
export class AppService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly saga: DeletionSagaService,
  ) {}

  /** Liveness : le processus repond. Aucune dependance sollicitee. */
  health(): { status: string; service: string } {
    return { status: 'ok', service: 'acervatim-identity' };
  }

  /**
   * Readiness. Base injoignable ou muette au-dela du delai : `unavailable`, que le
   * controleur traduit en `503`.
   *
   * `saga` est expose ici et pas seulement sur une route d'admin : une saga qui traine est
   * une non-conformite RGPD en cours, et une information de cette nature ne doit pas
   * dependre de la curiosite de celui qui regarde. Elle ne rend pas le service indisponible
   * pour autant - identity fonctionne, ce sont ses voisins qui ne repondent pas.
   */
  async ready(): Promise<{
    status: ReadinessStatus;
    db: boolean;
    users: number | null;
    saga: { pending: number; failed: number; stale: number } | null;
  }> {
    let db = true;
    let users: number | null = null;
    let saga: { pending: number; failed: number; stale: number } | null = null;
    try {
      // Un seul delai pour les deux lectures : elles visent la meme base.
      const [count, status] = await withDeadline(
        Promise.all([this.prisma.user.count(), this.saga.status()]),
      );
      users = count;
      saga = {
        pending: status.pending,
        failed: status.failed,
        stale: status.stale,
      };
    } catch {
      db = false;
    }
    return { status: readinessStatus(db), db, users, saga };
  }
}
