import { Injectable } from '@nestjs/common';
import { CatalogInternalService, ProfileRegistry } from '../catalog-core/src';
import { ConfigService } from '@nestjs/config';
import {
  ReadinessStatus,
  readinessStatus,
  withDeadline,
} from './common/health/readiness';

@Injectable()
export class AppService {
  constructor(
    private readonly internal: CatalogInternalService,
    private readonly profiles: ProfileRegistry,
    private readonly config: ConfigService,
  ) {}

  /** Liveness : le processus repond. Aucune dependance sollicitee. */
  health(): { status: string; service: string } {
    return { status: 'ok', service: 'acervatim-catalog-lego' };
  }

  /**
   * Readiness. Base injoignable ou muette au-dela du delai : `unavailable`, que le
   * controleur traduit en `503`.
   *
   * `registry` dit si ce catalog sait s'enregistrer aupres du gateway. Un `false` n'est pas
   * une panne - c'est le mode autonome - mais c'est **l'information la plus utile a
   * exposer** : sans registre, les ressources creees ici ne seront pas routables, et le
   * symptome (des `404` sur des ressources qui existent) est le plus difficile a
   * diagnostiquer de toute la cible (3.3).
   */
  async ready(): Promise<{
    status: ReadinessStatus;
    db: boolean;
    types: string[];
    counts: { collections: number; nodes: number; items: number } | null;
    registry: boolean;
    search: boolean;
  }> {
    let db = true;
    let counts: { collections: number; nodes: number; items: number } | null =
      null;
    try {
      counts = await withDeadline(this.internal.counts());
    } catch {
      db = false;
    }
    return {
      status: readinessStatus(db),
      db,
      types: this.profiles.codes(),
      counts,
      registry: Boolean(this.config.get<string>('GATEWAY_BASE_URL')),
      search: Boolean(this.config.get<string>('SEARCH_BASE_URL')),
    };
  }
}
