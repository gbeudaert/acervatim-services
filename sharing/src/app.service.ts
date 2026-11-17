import { Injectable } from '@nestjs/common';
import {
  ReadinessStatus,
  readinessStatus,
  withDeadline,
} from './common/health/readiness';
import { PrismaService } from './prisma/prisma.service';

@Injectable()
export class AppService {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness : le processus repond. Aucune dependance sollicitee. */
  health(): { status: string; service: string } {
    return { status: 'ok', service: 'acervatim-sharing' };
  }

  /**
   * Readiness. Base injoignable ou muette au-dela du delai : `unavailable`, que le
   * controleur traduit en `503`.
   *
   * Les catalogs ne sont **pas** sondes ici, bien que ce service en depende : un catalog
   * injoignable degrade la lecture des partages (les comptes manquent) sans empecher
   * `GET /internal/access` de repondre pour les collections d'un autre type. Le declarer
   * indisponible ferait croire a une panne generale de l'autorisation, qui est la fonction
   * la plus critique de ce service.
   */
  async ready(): Promise<{
    status: ReadinessStatus;
    db: boolean;
    shares: { active: number; members: number } | null;
  }> {
    let db = true;
    let shares: { active: number; members: number } | null = null;
    try {
      const [active, members] = await withDeadline(
        Promise.all([
          this.prisma.collectionShare.count({ where: { revokedAt: null } }),
          this.prisma.collectionShareMember.count({
            where: { revokedAt: null },
          }),
        ]),
      );
      shares = { active, members };
    } catch {
      db = false;
    }
    return { status: readinessStatus(db), db, shares };
  }
}
