import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  CollectionTypeCode,
  InternalCollectionOwner,
  InternalItemCountResponse,
  InternalRegistryEntriesPage,
  ShareStatus,
} from '../contracts';
import { CATALOG_DB, CatalogDb } from '../db';
import { ShareFilterService } from '../share-filter.service';

/** Taille de page du re-scan du registre. Bornee, le scan lit tout le catalogue. */
const MAX_SCAN_PAGE = 1000;

/**
 * Ce que le catalog rend aux autres services (6 de architecture-microservices.md).
 *
 * Trois familles, trois raisons d'exister :
 *  - `sharing` a besoin de savoir a qui appartient une collection et combien d'items un
 *    membre y verra (3.1, 3.2) ;
 *  - le gateway a besoin de pouvoir **reconstruire** son registre de routage (3.3) ;
 *  - `identity` a besoin de supprimer et d'exporter les donnees d'un compte (3.4).
 */
@Injectable()
export class CatalogInternalService {
  constructor(
    @Inject(CATALOG_DB) private readonly prisma: CatalogDb,
    private readonly shareFilter: ShareFilterService,
  ) {}

  /**
   * Proprietaire, type et nom d'une collection.
   *
   * `sharing` l'appelle a la creation d'un partage, en diffusant aux catalogs configures : il
   * ne connait pas encore le type. Un catalog qui ne sert pas cette collection repond `404`,
   * ce qui est la reponse **nominale** de cette diffusion, pas une erreur.
   */
  async collectionOwner(collectionId: string): Promise<InternalCollectionOwner> {
    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { id: true, userId: true, typeCode: true, name: true },
    });
    if (!collection) {
      throw new NotFoundException('Collection not found');
    }
    return {
      collectionId: collection.id,
      ownerUserId: collection.userId,
      typeCode: collection.typeCode as CollectionTypeCode,
      name: collection.name,
    };
  }

  /**
   * Nombre d'items visibles sous les statuts exposes, pour un lot d'entrees (3.2).
   *
   * **Un seul appel pour toutes les entrees d'un meme catalog.** Le monolithe notait deja que
   * le proprietaire n'a pas ce compte, parce qu'il couterait une requete par entree et par
   * partage sur une liste non plafonnee ; le decoupage en a fait le contrat.
   *
   * Le `name` voyage avec le compte : `sharing` en garde une copie denormalisee, faute de
   * pouvoir joindre `collections`, et cette reponse la realigne sans appel supplementaire -
   * la requete lit deja la collection.
   *
   * Une collection absente de la reponse a disparu : on ne rend pas `0` par omission, ce qui
   * ferait passer une suppression pour une collection vide.
   */
  async countItems(
    entries: Array<{ collectionId: string; statuses: ShareStatus[] }>,
  ): Promise<InternalItemCountResponse> {
    const ids = entries.map((e) => e.collectionId);
    const known = await this.prisma.collection.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    const nameById = new Map(known.map((c) => [c.id, c.name]));

    const counts = await Promise.all(
      entries
        .filter((e) => nameById.has(e.collectionId))
        .map(async (entry) => ({
          collectionId: entry.collectionId,
          count: await this.shareFilter.countItems(
            entry.collectionId,
            entry.statuses,
          ),
          name: nameById.get(entry.collectionId)!,
        })),
    );
    return { counts };
  }

  /**
   * Page du re-scan pour le job de reparation du registre (3.3).
   *
   * **Pagine et non transactionnel** : le scan s'execute pendant que ce catalog ecrit. Une
   * entree creee en cours de scan peut donc etre manquee - sans consequence, elle a ete
   * enregistree en synchrone a sa creation. Ce que le job corrige, ce sont les ecritures
   * perdues, pas les ecritures concurrentes.
   *
   * Le curseur porte sur les collections. Les ressources d'une page sont celles de ses
   * collections : cela garde chaque page coherente - une collection et ses items arrivent
   * ensemble - sans exiger de curseur composite.
   */
  async registryEntries(
    cursor: string | undefined,
    limit: number,
  ): Promise<InternalRegistryEntriesPage> {
    const take = Math.min(Math.max(limit, 1), MAX_SCAN_PAGE);
    const collections = await this.prisma.collection.findMany({
      take: take + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, userId: true, typeCode: true },
    });
    const hasMore = collections.length > take;
    const page = hasMore ? collections.slice(0, take) : collections;
    const collectionIds = page.map((c) => c.id);

    const [items, nodes] = await Promise.all([
      this.prisma.item.findMany({
        where: { collectionId: { in: collectionIds } },
        select: { id: true, collectionId: true },
      }),
      this.prisma.collectionNode.findMany({
        where: { collectionId: { in: collectionIds } },
        select: { id: true, collectionId: true },
      }),
    ]);

    return {
      collections: page.map((c) => ({
        collectionId: c.id,
        userId: c.userId,
        typeCode: c.typeCode as CollectionTypeCode,
      })),
      resources: [
        ...items.map((i) => ({
          resourceId: i.id,
          kind: 'item' as const,
          collectionId: i.collectionId,
        })),
        ...nodes.map((n) => ({
          resourceId: n.id,
          kind: 'node' as const,
          collectionId: n.collectionId,
        })),
      ],
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  /**
   * Participant de la saga RGPD (3.4), **idempotent**.
   *
   * Supprimer les collections suffit : items et noeuds partent par la cascade **intra-schema**,
   * qui survit au decoupage. Les items orphelins - sans collection - n'existent pas dans ce
   * modele.
   *
   * Les entrees du registre de routage ne sont **pas** retirees ici, et c'est deliberé : ce
   * serait N appels reseau au gateway au milieu d'une saga qui doit aboutir, pour des entrees
   * que son job de reparation nocturne purge de lui-meme. Entre-temps elles routent vers ce
   * catalog, qui repond `404` - le comportement correct pour une ressource supprimee.
   */
  async deleteUserData(userId: string): Promise<{ deleted: number }> {
    const res = await this.prisma.collection.deleteMany({ where: { userId } });
    return { deleted: res.count };
  }

  /**
   * Fragment d'export RGPD.
   *
   * Les cles sont **celles du monolithe** (`collections`, `collectionNodes`, `items`) :
   * `identity` les aplatit dans le payload, et les renommer changerait la forme d'un fichier
   * fait pour etre relu ailleurs.
   *
   * Les noeuds y figurent : sans eux, l'export amputerait la collection de tout le niveau
   * serie - note, commentaire, `isWishlist`, synopsis cure.
   */
  async exportUserData(userId: string): Promise<Record<string, unknown>> {
    const [collections, collectionNodes, items] = await Promise.all([
      this.prisma.collection.findMany({ where: { userId } }),
      this.prisma.collectionNode.findMany({ where: { userId } }),
      this.prisma.item.findMany({ where: { userId } }),
    ]);
    return { collections, collectionNodes, items };
  }

  /** Compteurs pour `/health/ready`. */
  async counts(): Promise<{
    collections: number;
    nodes: number;
    items: number;
  }> {
    const [collections, nodes, items] = await Promise.all([
      this.prisma.collection.count(),
      this.prisma.collectionNode.count(),
      this.prisma.item.count(),
    ]);
    return { collections, nodes, items };
  }
}
