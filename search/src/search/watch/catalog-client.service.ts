import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  InternalNodesPage,
  InternalUserNodes,
} from '../../common/internal/contracts';
import {
  InternalCallError,
  InternalClientService,
} from '../../common/internal/internal-client.service';

/** Ce que le rattrapage surveille : les noeuds « serie » des collections manga. */
const MANGA_TYPE_CODE = 'manga';
const SERIE_LEVEL = 'serie';

/**
 * Lecture des series manga aupres de `catalog-manga`, pour le rattrapage des tomes parus apres
 * l'import.
 *
 * Dans le monolithe, le job lisait `collection_nodes` et `items` directement. Ces tables vivent
 * desormais dans `acv_cat_manga`, que ce service ne joint pas : il demande, le catalog repond
 * (6 de architecture-microservices.md). Le type etant connu, un seul catalog est interroge -
 * aucune diffusion, contrairement a `sharing` qui ne connait pas le type a la creation d'un
 * partage.
 *
 * Les deux lectures sont **strictes** : un catalog injoignable fait echouer l'appelant. Rendre
 * une liste vide ferait passer une panne pour « aucune serie », et le passage hebdomadaire se
 * terminerait avec succes sans rien avoir verifie.
 */
@Injectable()
export class CatalogClientService {
  constructor(
    private readonly internal: InternalClientService,
    private readonly config: ConfigService,
  ) {}

  /** Faux quand `CATALOG_MANGA_BASE_URL` manque - developpement de `search` seul. */
  isConfigured(): boolean {
    return Boolean(this.config.get<string>('CATALOG_MANGA_BASE_URL'));
  }

  /** Une page des series manga, tous comptes confondus (passage hebdomadaire). */
  async seriesPage(
    cursor: string | undefined,
    limit: number,
  ): Promise<InternalNodesPage> {
    const params = new URLSearchParams({
      typeCode: MANGA_TYPE_CODE,
      level: SERIE_LEVEL,
      limit: String(limit),
    });
    if (cursor) params.set('cursor', cursor);
    return this.get<InternalNodesPage>(`/internal/nodes?${params.toString()}`);
  }

  /** Les series manga d'un compte, avec les volumes deja presents sous chacune. */
  async userSeries(userId: string): Promise<InternalUserNodes> {
    const params = new URLSearchParams({
      typeCode: MANGA_TYPE_CODE,
      level: SERIE_LEVEL,
    });
    return this.get<InternalUserNodes>(
      `/internal/users/${encodeURIComponent(userId)}/nodes?${params.toString()}`,
    );
  }

  private async get<T>(path: string): Promise<T> {
    const baseUrl = this.config.get<string>('CATALOG_MANGA_BASE_URL');
    if (!baseUrl) {
      throw new ServiceUnavailableException(
        'catalog-manga non configure (CATALOG_MANGA_BASE_URL)',
      );
    }
    try {
      return await this.internal.request<T>(baseUrl, path);
    } catch (err) {
      // Le voisin a repondu en erreur : pour l'appelant de `search`, c'est une passerelle en
      // panne, pas une erreur de sa requete - d'ou 502 et non le statut du catalog.
      if (err instanceof InternalCallError) {
        throw new BadGatewayException(`catalog-manga a repondu ${err.status}`);
      }
      throw err;
    }
  }
}
