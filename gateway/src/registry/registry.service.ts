import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CollectionTypeCode,
  InternalRegistryUpsert,
} from '../common/internal/contracts';
import { PrismaService } from '../prisma/prisma.service';

export interface ResolvedCollection {
  collectionId: string;
  userId: string;
  typeCode: CollectionTypeCode;
}

/**
 * Registre de routage `collectionId -> typeCode` (3.3 de architecture-microservices.md).
 *
 * `GET /v1/items/:id`, `PATCH /v1/nodes/:id` et `GET /v1/collections/:id` ne portent pas le
 * type de collection. Sans ce registre, le gateway ne peut pas router - et diffuser chaque
 * lecture a tous les catalogs est exclu. C'est le prix du decoupage par type, paye ici.
 *
 * Les catalogs l'ecrivent **en synchrone** a la creation et a la suppression. Toutes les
 * ecritures sont idempotentes : un catalog qui rejoue son enregistrement au boot, ou qui
 * retente apres une coupure, ne doit produire ni doublon ni erreur.
 */
@Injectable()
export class RegistryService {
  private readonly logger = new Logger(RegistryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Collection connue du registre, ou `null`. */
  async findCollection(
    collectionId: string,
  ): Promise<ResolvedCollection | null> {
    const row = await this.prisma.collectionRegistry.findUnique({
      where: { collectionId },
    });
    if (!row) return null;
    return {
      collectionId: row.collectionId,
      userId: row.userId,
      typeCode: row.typeCode as CollectionTypeCode,
    };
  }

  /**
   * Collection portant cette ressource (item ou noeud), ou `null`.
   *
   * `kind` est **verifie**, pas seulement informatif : sans ce controle, un identifiant de
   * noeud passe a `GET /v1/items/:id` serait route vers le bon catalog, qui repondrait 404
   * - correct, mais apres un aller-retour reseau inutile, et surtout en masquant une
   * incoherence de client derriere une reponse d'apparence normale.
   */
  async findResourceCollection(
    resourceId: string,
    kind: 'item' | 'node',
  ): Promise<ResolvedCollection | null> {
    const row = await this.prisma.resourceRegistry.findUnique({
      where: { resourceId },
    });
    if (!row || row.kind !== kind) return null;
    return this.findCollection(row.collectionId);
  }

  /**
   * Enregistre collections et ressources. Idempotent par `upsert`.
   *
   * Une seule transaction par appel : un catalog qui cree un item et son noeud parent doit
   * les voir apparaitre ensemble, sinon une lecture concurrente route l'un et pas l'autre.
   */
  async upsert(payload: InternalRegistryUpsert): Promise<{ written: number }> {
    const collections = payload.collections ?? [];
    const resources = payload.resources ?? [];
    if (collections.length === 0 && resources.length === 0) {
      return { written: 0 };
    }

    await this.prisma.$transaction([
      ...collections.map((c) =>
        this.prisma.collectionRegistry.upsert({
          where: { collectionId: c.collectionId },
          create: {
            collectionId: c.collectionId,
            userId: c.userId,
            typeCode: c.typeCode,
          },
          // Le type d'une collection ne change pas, mais le proprietaire peut avoir ete
          // corrige par une reconstruction : on realigne plutot que d'ignorer.
          update: { userId: c.userId, typeCode: c.typeCode },
        }),
      ),
      ...resources.map((r) =>
        this.prisma.resourceRegistry.upsert({
          where: { resourceId: r.resourceId },
          create: {
            resourceId: r.resourceId,
            kind: r.kind,
            collectionId: r.collectionId,
          },
          // Un item peut changer de noeud, jamais de collection ni de genre : si c'est le
          // cas, c'est le registre qui avait tort.
          update: { kind: r.kind, collectionId: r.collectionId },
        }),
      ),
    ]);

    return { written: collections.length + resources.length };
  }

  /**
   * Retire une entree. Idempotent : supprimer deux fois n'est pas une erreur, c'est
   * exactement ce qu'un catalog fait quand il rejoue une suppression apres une coupure.
   *
   * Supprimer une collection purge **ses ressources** : la cascade SQL n'existe pas ici,
   * la FK non plus. Sans cette purge, le registre garderait des items pointant vers une
   * collection disparue et router ait vers un catalog qui repondrait 404 - le symptome
   * decrit en 3.3, precisement.
   */
  async remove(id: string): Promise<{ deleted: number }> {
    const [resourcesOfCollection, collection, resource] =
      await this.prisma.$transaction([
        this.prisma.resourceRegistry.deleteMany({
          where: { collectionId: id },
        }),
        this.prisma.collectionRegistry.deleteMany({
          where: { collectionId: id },
        }),
        this.prisma.resourceRegistry.deleteMany({ where: { resourceId: id } }),
      ]);
    return {
      deleted:
        resourcesOfCollection.count + collection.count + resource.count,
    };
  }

  /** Types de collection que cet utilisateur possede - la cible d'un scatter-gather. */
  async typesOwnedBy(userId: string): Promise<CollectionTypeCode[]> {
    const rows = await this.prisma.collectionRegistry.findMany({
      where: { userId },
      select: { typeCode: true },
      distinct: ['typeCode'],
    });
    return rows.map((r) => r.typeCode as CollectionTypeCode);
  }

  /** Collection connue, ou 404 - jamais un message qui confirmerait l'existence ailleurs. */
  async requireCollection(collectionId: string): Promise<ResolvedCollection> {
    const found = await this.findCollection(collectionId);
    if (!found) {
      this.logger.debug(`registre: collection inconnue ${collectionId}`);
      throw new NotFoundException('Collection not found');
    }
    return found;
  }
}
