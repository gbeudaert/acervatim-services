import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Collection, Prisma } from '@prisma/client';
import { accessStatuses, CollectionAccess } from '../access';
import { CollectionTypeCode } from '../contracts';
import { CATALOG_DB, CatalogDb } from '../db';
import { LimitsService } from '../limits.service';
import { CursorPage, paginate } from '../pagination/paginate';
import { RegistryClientService } from '../clients/registry-client.service';
import { ShareFilterService } from '../share-filter.service';
import { HierarchySummaryEntry, summarizeHierarchy } from '../types/hierarchy';
import { ProfileRegistry } from '../types/registry';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { ListCollectionsQueryDto } from './dto/list-collections.query';
import { UpdateCollectionDto } from './dto/update-collection.dto';

/**
 * Le client manipule le **code** stable du type (`vinyl`, `manga`), expose sous `type`.
 *
 * Dans le monolithe, `typeId` etait un UUID en FK vers `collection_types`, et `toResponse`
 * masquait cette colonne. La FK a disparu avec le decoupage - `collection_types` appartient a
 * `identity` - et la colonne stocke desormais le code directement. La reponse ne change pas :
 * c'est bien le meme champ `type` que l'app lit depuis la V1.
 */
export type CollectionResponse = Omit<Collection, 'typeCode'> & {
  type: string;
};

/** Detail enrichi du resume de hierarchie (noeuds par niveau ; `[]` = type plat). */
export type CollectionDetailResponse = CollectionResponse & {
  hierarchy: HierarchySummaryEntry[];
};

/** Champs de `unifiedData` couverts par la recherche `items[in]`/`items[all]`. */
const ITEM_SEARCH_FIELDS = ['title', 'name', 'artist', 'author'] as const;

/**
 * `string_contains` de Prisma compare via `JSON_UNQUOTE(...)`, qui ressort en collation
 * `utf8mb4_bin` sur MariaDB - sensible a la casse - et MySQL n'a pas de `mode: 'insensitive'`.
 * D'ou du SQL parametre avec `COLLATE utf8mb4_general_ci` pour un contains insensible.
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

@Injectable()
export class CollectionsService {
  constructor(
    @Inject(CATALOG_DB) private readonly prisma: CatalogDb,
    private readonly limits: LimitsService,
    private readonly shareFilter: ShareFilterService,
    private readonly profiles: ProfileRegistry,
    private readonly registry: RegistryClientService,
  ) {}

  private toResponse(collection: Collection): CollectionResponse {
    return {
      id: collection.id,
      userId: collection.userId,
      name: collection.name,
      description: collection.description,
      itemCount: collection.itemCount,
      createdAt: collection.createdAt,
      updatedAt: collection.updatedAt,
      type: collection.typeCode,
    };
  }

  /**
   * Ids des collections de `userId` ayant au moins un item dont un champ recherche contient
   * `term`. Un appel SQL par terme.
   */
  private async matchingCollectionIds(
    userId: string,
    term: string,
  ): Promise<string[]> {
    const pattern = `%${escapeLike(term)}%`;
    const clauses = ITEM_SEARCH_FIELDS.map(
      (field) =>
        Prisma.sql`JSON_UNQUOTE(JSON_EXTRACT(i.unified_data, ${`$.${field}`})) COLLATE utf8mb4_general_ci LIKE ${pattern}`,
    );
    const rows = await this.prisma.$queryRaw<{ collectionId: string }[]>`
      SELECT DISTINCT i.collection_id AS collectionId
      FROM items i
      WHERE i.user_id = ${userId}
        AND (${Prisma.join(clauses, ' OR ')})
    `;
    return rows.map((r) => r.collectionId);
  }

  /**
   * Combine `items[in]` (OR = union des termes) et `items[all]` (AND = un ensemble par terme),
   * puis intersecte le tout - les filtres se combinent en AND.
   */
  private async resolveItemFilterIds(
    userId: string,
    items: { in?: string[]; all?: string[] },
  ): Promise<string[]> {
    const sets: Set<string>[] = [];
    if (items.in) {
      const union = new Set<string>();
      for (const term of items.in) {
        for (const id of await this.matchingCollectionIds(userId, term)) {
          union.add(id);
        }
      }
      sets.push(union);
    }
    if (items.all) {
      for (const term of items.all) {
        sets.push(new Set(await this.matchingCollectionIds(userId, term)));
      }
    }
    if (sets.length === 0) return [];
    let acc = [...sets[0]];
    for (let i = 1; i < sets.length; i++) {
      acc = acc.filter((id) => sets[i].has(id));
    }
    return acc;
  }

  /** 404 si la collection appartient a un autre utilisateur - pas de 403, pas de fuite. */
  private async assertOwned(userId: string, id: string): Promise<void> {
    const collection = await this.prisma.collection.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!collection) {
      throw new NotFoundException('Collection not found');
    }
  }

  /**
   * `typeCode` est valide contre les profils **servis par ce catalog**.
   *
   * Dans le monolithe, un type inconnu etait un `400` parce que la ligne manquait dans
   * `collection_types`. Ici la table n'existe plus : le controle porte sur ce que ce
   * processus sait faire. Un type valide mais servi par un autre catalog est un cas de
   * mauvais routage - le gateway ne devrait jamais l'envoyer ici - et le refuser franchement
   * vaut mieux que de creer une collection que personne ne saura router ensuite.
   */
  async create(
    userId: string,
    dto: CreateCollectionDto,
  ): Promise<CollectionResponse> {
    if (!this.profiles.serves(dto.typeCode)) {
      throw new BadRequestException(
        `Unknown collection type: ${dto.typeCode}`,
      );
    }

    // Plafond technique + create dans la meme transaction : reduit la fenetre TOCTOU sous
    // concurrence (sans SELECT FOR UPDATE le risque subsiste).
    const collection = await this.prisma.$transaction(async (tx) => {
      await this.limits.assertCanCreateCollection(userId, tx);
      return tx.collection.create({
        data: {
          userId,
          typeCode: dto.typeCode,
          name: dto.name,
          description: dto.description,
        },
      });
    });

    // Enregistrement au registre de routage APRES la transaction : un appel reseau dans une
    // transaction MariaDB la tiendrait ouverte le temps du round-trip. Un echec ne fait pas
    // echouer la creation - voir `RegistryClientService`.
    await this.registry.registerCollection(
      collection.id,
      userId,
      collection.typeCode as CollectionTypeCode,
    );

    return this.toResponse(collection);
  }

  /**
   * **Mes** collections uniquement. Celles qu'on me partage ne s'y melangent pas : elles se
   * listent par `GET /v1/shares/received`, qui porte en plus la portee et le partage
   * d'origine. Les confondre ferait entrer des collections d'autrui dans les compteurs et les
   * plafonds du requerant.
   *
   * Le filtre `type[in]` est conserve bien que ce catalog ne serve qu'un sous-ensemble des
   * types : c'est le gateway qui decide quels catalogs interroger, et un filtre relaye tel
   * quel garantit que la reponse de chacun reste correcte prise isolement.
   */
  async list(
    userId: string,
    query: ListCollectionsQueryDto,
  ): Promise<CursorPage<CollectionResponse>> {
    const where: Prisma.CollectionWhereInput = {
      userId,
      ...(query.type ? { typeCode: { in: query.type.in } } : {}),
    };
    if (query.items) {
      const ids = await this.resolveItemFilterIds(userId, query.items);
      if (ids.length === 0) {
        // Aucun item ne matche : page vide, sans requete supplementaire.
        return {
          data: [],
          meta: { pagination: { nextCursor: null, limit: query.limit } },
        };
      }
      where.id = { in: ids };
    }
    const page = await paginate(
      (take, cursor) =>
        this.prisma.collection.findMany({
          where,
          take,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          // `id desc` en tiebreaker : deux lignes de meme `createdAt` (import en masse,
          // fixtures) ne se retrouvent jamais dupliquees ou sautees entre deux pages.
          //
          // **Cet ordre est aussi celui du scatter-gather du gateway** (3.7) : changer l'un
          // sans l'autre casse la fusion multi-catalogs, en silence.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      query.cursor,
      query.limit,
    );
    return { ...page, data: page.data.map((c) => this.toResponse(c)) };
  }

  /**
   * Detail d'une collection, du point de vue du requerant.
   *
   * Pour un membre, les compteurs sont **recalcules sous ce qui lui est expose** :
   * `itemCount` est denormalise sur la collection entiere et le resume de hierarchie compte
   * tous les noeuds. Servis tels quels, ils afficheraient « 240 elements » et « 30 series »
   * sur une vue qui en montre 12 et 3.
   */
  async findOne(access: CollectionAccess): Promise<CollectionDetailResponse> {
    const id = access.collectionId;
    const collection = await this.prisma.collection.findUnique({
      where: { id },
    });
    if (!collection) {
      throw new NotFoundException('Collection not found');
    }
    const statuses = accessStatuses(access);
    const profile = this.profiles.get(collection.typeCode);
    let hierarchy: HierarchySummaryEntry[] = [];
    if (profile.hierarchy.length > 0) {
      const scoped = await this.shareFilter.nodeWhere(id, statuses);
      const groups = await this.prisma.collectionNode.groupBy({
        by: ['level'],
        where: { collectionId: id, ...(scoped ? { AND: [scoped] } : {}) },
        _count: { _all: true },
      });
      const counts: Record<string, number> = Object.fromEntries(
        groups.map((g) => [g.level, g._count._all]),
      );
      hierarchy = summarizeHierarchy(profile, counts);
    }
    const response = this.toResponse(collection);
    if (access.role === 'shared') {
      response.itemCount = await this.shareFilter.countItems(id, statuses);
    }
    return { ...response, hierarchy };
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateCollectionDto,
  ): Promise<CollectionResponse> {
    await this.assertOwned(userId, id);
    const collection = await this.prisma.collection.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
      },
    });
    return this.toResponse(collection);
  }

  /**
   * Supprime la collection, ses noeuds et ses items (cascade **intra-schema**, elle survit au
   * decoupage), puis retire l'entree du registre de routage.
   *
   * Le desenregistrement vient apres la suppression : dans l'autre ordre, une requete
   * concurrente pourrait etre routee vers une collection deja effacee - un `404` correct
   * obtenu par le mauvais chemin. Ici, la fenetre residuelle route vers une collection
   * disparue, ce que le catalog traite en `404` de lui-meme.
   */
  async remove(userId: string, id: string): Promise<void> {
    await this.assertOwned(userId, id);
    await this.prisma.collection.delete({ where: { id } });
    await this.registry.unregister(id);
  }
}
