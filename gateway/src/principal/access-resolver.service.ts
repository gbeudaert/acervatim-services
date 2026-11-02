import { Injectable, Logger } from '@nestjs/common';
import { InternalAccess } from '../common/internal/contracts';
import {
  InternalCallError,
  InternalClientService,
} from '../common/internal/internal-client.service';
import { ServiceRegistryService } from '../routing/service-registry.service';

/**
 * Resolution de l'acces a une collection aupres de `sharing` (3.1).
 *
 * C'est l'inversion de dependance qui rend le decoupage possible : dans le monolithe,
 * `ShareFilterService` etait injecte **dans** les services du domaine collection et y
 * joignait en SQL brut `collection_share_entries` a `items`. La dependance etait
 * bidirectionnelle et ne survit pas a la separation des schemas. Desormais `sharing`
 * repond « voici le role et les statuts », et le catalog applique le filtre chez lui, sur
 * ses propres tables - `Item.userData` porte le statut, donc il lui appartient.
 *
 * Le gateway resout **une fois** et propage le resultat dans le principal signe : les
 * services aval ne re-resolvent rien, ce qui preserve l'invariant du monolithe - les
 * statuts n'ont aucun chemin par lequel arriver du client.
 */
@Injectable()
export class AccessResolverService {
  private readonly logger = new Logger(AccessResolverService.name);

  constructor(
    private readonly internal: InternalClientService,
    private readonly services: ServiceRegistryService,
  ) {}

  /**
   * `null` = aucun acces. Volontairement indistinguable de « la collection n'existe pas » :
   * confirmer l'existence d'une ressource d'autrui donnerait un oracle a qui balaie des
   * identifiants.
   *
   * En cas d'echec de `sharing`, on leve plutot que de renvoyer `null` : un `null` ici se
   * traduirait en `404` et ferait passer une panne pour une suppression - le client
   * effacerait alors de bonne foi une collection qui existe toujours.
   */
  async resolve(
    userId: string,
    collectionId: string,
    requestId?: string,
  ): Promise<InternalAccess | null> {
    const baseUrl = this.services.require('sharing');
    const query = new URLSearchParams({ userId, collectionId });
    try {
      return await this.internal.request<InternalAccess>(
        baseUrl,
        `/internal/access?${query.toString()}`,
        { requestId },
      );
    } catch (err) {
      // 404 est la reponse **nominale** de `sharing` pour « aucun acces ».
      if (err instanceof InternalCallError && err.status === 404) {
        return null;
      }
      this.logger.warn(
        `resolution d'acces indisponible pour la collection ${collectionId}`,
      );
      throw err;
    }
  }
}
