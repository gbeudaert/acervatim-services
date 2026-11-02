import { Injectable } from '@nestjs/common';
import { InternalAccess } from '../common/internal/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogClientService } from './catalog-client.service';
import {
  ALL_SHARE_STATUSES,
  parseStatuses,
  unionStatuses,
} from './share-statuses';

/**
 * Resolution « quelle collection cette requete vise-t-elle, et a quel titre » (3.1).
 *
 * C'est le `CollectionAccessService` du monolithe, deplace de `premium/` vers `sharing` comme
 * l'architecture le prevoit, et retourne : dans le monolithe, il **lisait** la table
 * `collections` pour trancher le cas proprietaire ; il interroge maintenant le catalog par
 * `GET /internal/collections/:id/owner`.
 *
 * Le reste - l'union des statuts des partages actifs - n'a pas bouge, parce que rien de tout
 * cela ne franchissait deja une frontiere : les partages sont ici, et eux seuls.
 *
 * ### Ce que cette classe ne fait plus
 *
 * Le monolithe avait aussi un `ShareFilterService` **injecte dans trois services du domaine
 * collection** (`collections`, `items`, `nodes`), qui y faisait du SQL brut joignant
 * `collection_share_entries` a `items`. C'est la dependance bidirectionnelle que le 3.1
 * supprime : `sharing` rend desormais les **statuts autorises**, et le catalog applique le
 * filtre chez lui, sur ses propres tables - le `status` d'un item vit dans son `userData`,
 * donc il lui appartient.
 */
@Injectable()
export class CollectionAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogs: CatalogClientService,
  ) {}

  /**
   * `null` s'il n'y a aucun acces : collection inexistante, appartenant a quelqu'un d'autre,
   * ou partage/adhesion revoques - **indistinguables volontairement**. Confirmer l'existence
   * d'une ressource d'autrui donnerait un oracle a qui balaie des identifiants.
   *
   * `expiresAt` n'entre **pas** dans le filtre : il borne l'usage du *code*, pas l'adhesion
   * deja acquise. Un partage expire cesse d'etre rejoignable ; ceux qui l'ont rejoint
   * continuent de lire jusqu'a revocation. Faire l'inverse ici ferait mentir
   * `GET /v1/shares/received`, qui les liste encore.
   */
  async resolve(
    userId: string,
    collectionId: string,
  ): Promise<InternalAccess | null> {
    const collection = await this.catalogs.findCollection(collectionId);
    if (!collection) return null;

    if (collection.ownerUserId === userId) {
      return {
        collectionId: collection.collectionId,
        ownerUserId: collection.ownerUserId,
        role: 'owner',
        // Le proprietaire voit 100 % de sa collection : il n'y a rien a filtrer.
        statuses: [...ALL_SHARE_STATUSES],
      };
    }

    // Les entrees qui exposent CETTE collection, parmi les partages vivants que ce membre a
    // rejoints. Un partage porte N collections : c'est l'entree, pas le partage, qui dit ce
    // qu'on voit d'ici.
    const entries = await this.prisma.collectionShareEntry.findMany({
      where: {
        collectionId,
        share: {
          revokedAt: null,
          members: { some: { memberUserId: userId, revokedAt: null } },
        },
      },
      select: { statuses: true },
    });
    if (entries.length === 0) return null;

    // Plusieurs partages actifs de la meme collection : le membre voit la reunion de ce que
    // chacun lui accorde - ni plus, ni moins.
    const statuses = unionStatuses(
      entries.map((entry) => parseStatuses(entry.statuses)),
    );
    // Ensemble vide (ligne abimee) : pas d'acces du tout, plutot qu'un acces qui ne montre
    // rien - lequel serait indiscernable d'une collection reellement vide.
    if (statuses.length === 0) return null;

    return {
      collectionId: collection.collectionId,
      ownerUserId: collection.ownerUserId,
      role: 'shared',
      statuses,
    };
  }
}
