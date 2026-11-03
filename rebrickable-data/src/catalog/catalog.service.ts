import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { LegoSet, LegoTheme, Prisma } from '@prisma/client';
import { barcodeVariants } from '../brickset/barcode';
import {
  InternalLegoSet,
  InternalLegoSetPage,
  InternalLegoTheme,
} from '../common/internal/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { IndexedTheme, ThemeIndex, ThemeNode } from './theme-tree';

/** Un meme code peut couvrir plusieurs references (multipacks, editions regionales). */
const BARCODE_MATCH_LIMIT = 20;
const ORDER_BY: Prisma.LegoSetOrderByWithRelationInput[] = [
  { year: 'desc' },
  { setNum: 'asc' },
];

export interface SetSearchQuery {
  q?: string;
  theme?: string;
  offset: number;
  limit: number;
}

/**
 * Lectures du catalogue, toutes **locales** : aucune ne declenche d'appel sortant - ni import
 * CSV, ni moissonnage Brickset. C'est ce qui permet de les servir sur le chemin d'une requete.
 *
 * L'arbre des themes (~500 lignes) est tenu en memoire : il est lu a chaque filtre `theme=` pour
 * en calculer la descendance. Il est recharge au boot et apres chaque import.
 */
@Injectable()
export class CatalogService implements OnModuleInit {
  private readonly logger = new Logger(CatalogService.name);
  private themeIndex: ThemeIndex | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      const index = await this.reloadThemes();
      this.logger.log(`themes: ${index.size} en memoire`);
    } catch (err) {
      // Base pas encore migree, ou injoignable : la premiere lecture retentera.
      this.logger.warn(
        `themes non charges au boot: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Recharge l'arbre depuis la base. Appele par l'import des que les themes sont ecrits. */
  async reloadThemes(): Promise<ThemeIndex> {
    const rows = await this.prisma.legoTheme.findMany();
    this.themeIndex = new ThemeIndex(rows.map(toNode));
    return this.themeIndex;
  }

  async searchSets(query: SetSearchQuery): Promise<InternalLegoSetPage> {
    const themes = await this.themes();
    let themeIds: number[] | undefined;
    if (query.theme) {
      const node = themes.resolve(query.theme);
      if (!node) throw new NotFoundException(`Unknown theme: ${query.theme}`);
      themeIds = themes.descendantIds(node.id);
    }

    const term = query.q?.trim();
    const where: Prisma.LegoSetWhereInput = {
      ...(term
        ? {
            OR: [
              { setNum: { startsWith: term } },
              { name: { contains: term } },
            ],
          }
        : {}),
      ...(themeIds ? { themeId: { in: themeIds } } : {}),
    };

    const rows = await this.prisma.legoSet.findMany({
      where,
      orderBy: ORDER_BY,
      skip: query.offset,
      take: query.limit + 1,
    });
    const hasMore = rows.length > query.limit;
    return {
      items: rows.slice(0, query.limit).map((r) => toInternalSet(r, themes)),
      hasMore,
    };
  }

  /**
   * Resolution d'un code scanne. Renvoie toutes les correspondances : trancher a la place de
   * l'utilisateur entre deux references produirait un faux silencieux.
   */
  async findByBarcode(code: string): Promise<InternalLegoSet[]> {
    const variants = barcodeVariants(code);
    if (variants.length === 0) return [];
    const [themes, rows] = await Promise.all([
      this.themes(),
      this.prisma.legoSet.findMany({
        where: { OR: [{ ean: { in: variants } }, { upc: { in: variants } }] },
        orderBy: ORDER_BY,
        take: BARCODE_MATCH_LIMIT,
      }),
    ]);
    return rows.map((r) => toInternalSet(r, themes));
  }

  async getSet(setNum: string): Promise<InternalLegoSet> {
    const [themes, row] = await Promise.all([
      this.themes(),
      this.prisma.legoSet.findUnique({ where: { setNum } }),
    ]);
    if (!row) throw new NotFoundException(`Unknown set: ${setNum}`);
    return toInternalSet(row, themes);
  }

  /** `parent` absent : les themes de tete. Sinon les enfants directs du theme designe. */
  async listThemes(parent?: string): Promise<InternalLegoTheme[]> {
    const themes = await this.themes();
    if (!parent) return themes.topLevel().map(toInternalTheme);
    const node = themes.resolve(parent);
    if (!node) throw new NotFoundException(`Unknown theme: ${parent}`);
    return themes.children(node.id).map(toInternalTheme);
  }

  /** Comptes exposes par `GET /admin/status`. */
  async counts(): Promise<{
    sets: number;
    setsWithBarcode: number;
    setsWithMinifigs: number;
    themes: number;
  }> {
    const [sets, setsWithBarcode, setsWithMinifigs, themes] = await Promise.all(
      [
        this.prisma.legoSet.count(),
        this.prisma.legoSet.count({
          where: { OR: [{ ean: { not: null } }, { upc: { not: null } }] },
        }),
        this.prisma.legoSet.count({ where: { minifigs: { gt: 0 } } }),
        this.prisma.legoTheme.count(),
      ],
    );
    return { sets, setsWithBarcode, setsWithMinifigs, themes };
  }

  private async themes(): Promise<ThemeIndex> {
    return this.themeIndex ?? this.reloadThemes();
  }
}

function toNode(r: LegoTheme): IndexedTheme {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    parentId: r.parentId,
    path: r.path,
    depth: r.depth,
    retired: r.retiredAt !== null,
  };
}

function toInternalTheme(t: ThemeNode): InternalLegoTheme {
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    parentId: t.parentId,
    path: t.path,
    depth: t.depth,
  };
}

export function toInternalSet(
  row: LegoSet,
  themes: ThemeIndex,
): InternalLegoSet {
  const theme = row.themeId !== null ? themes.findById(row.themeId) : null;
  return {
    setNum: row.setNum,
    setNumber: setNumber(row.setNum),
    name: row.name,
    year: row.year,
    numParts: row.numParts,
    minifigs: row.minifigs,
    imageUrl: row.imageUrl,
    theme: theme
      ? { id: theme.id, name: theme.name, path: theme.path, slug: theme.slug }
      : null,
    barcodes: { ean: row.ean, upc: row.upc },
    contributedBy:
      row.bricksetId !== null ? ['rebrickable', 'brickset'] : ['rebrickable'],
  };
}

/**
 * "42131-1" -> "42131". Seul le dernier segment numerique est la version : certains numeros
 * Rebrickable portent eux-memes des tirets ("113-2-DBASE-1" -> "113-2-DBASE").
 */
export function setNumber(setNum: string): string {
  const match = /^(.+)-\d+$/.exec(setNum);
  return match ? match[1] : setNum;
}
