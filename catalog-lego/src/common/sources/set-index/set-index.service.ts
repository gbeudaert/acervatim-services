import { Injectable, Logger } from '@nestjs/common';
import { LegoSet, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { BricksetSet } from '../brickset/brickset.types';
import { RebrickableSet } from '../rebrickable/rebrickable.types';
import { LegoSourceCode, UnifiedLegoSet } from '../types';
import { barcodeVariants, normalizeBarcode } from './barcode';
import { ThemeSyncService } from './theme-sync.service';

/**
 * Index local du catalogue LEGO : miroir de Rebrickable enrichi des codes-barres Brickset.
 *
 * Il existe pour une raison precise : **aucune API LEGO gratuite ne resout un code-barres en
 * set**. Rebrickable ne connait pas l'EAN ; Brickset le publie mais ne permet pas de chercher
 * dessus, et son quota (100 appels/jour) exclut de toute facon l'appel en ligne ; BrickOwl ne
 * reconnait que ses propres identifiants ; BrickLink impose un OAuth 1.0a a IP declaree. Le scan
 * n'est donc realisable que si l'on retourne le probleme : moissonner hors ligne, indexer, et
 * repondre en local.
 *
 * Effet de bord heureux : la recherche par nom reste servie en mode degrade (sans jeton, sans
 * premium) sur la part du catalogue deja moissonnee.
 */
@Injectable()
export class SetIndexService {
  private readonly logger = new Logger(SetIndexService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly themes: ThemeSyncService,
  ) {}

  /**
   * Resolution d'un code scanne. Renvoie tous les sets correspondants : un meme code peut
   * couvrir plusieurs references (multipacks, editions regionales), et trancher a la place de
   * l'utilisateur produirait un faux silencieux. L'app affiche le choix quand il y en a un.
   */
  async findByBarcode(raw: string): Promise<LegoSet[]> {
    const variants = barcodeVariants(raw);
    if (variants.length === 0) return [];

    return this.prisma.legoSet.findMany({
      where: {
        OR: [{ ean: { in: variants } }, { upc: { in: variants } }],
      },
      orderBy: [{ year: 'desc' }, { setNum: 'asc' }],
      take: 20,
    });
  }

  /** Recherche par nom dans l'index local (mode degrade et repli quand la source est muette). */
  async searchByName(
    q: string,
    themeIds: number[] | undefined,
    skip: number,
    take: number,
  ): Promise<LegoSet[]> {
    const where: Prisma.LegoSetWhereInput = {
      name: { contains: q },
      ...(themeIds && themeIds.length > 0 ? { themeId: { in: themeIds } } : {}),
    };
    return this.prisma.legoSet.findMany({
      where,
      orderBy: [{ year: 'desc' }, { setNum: 'asc' }],
      skip,
      take,
    });
  }

  async findBySetNum(setNum: string): Promise<LegoSet | null> {
    return this.prisma.legoSet.findUnique({ where: { setNum } });
  }

  async count(): Promise<{ total: number; withBarcode: number }> {
    const [total, withBarcode] = await Promise.all([
      this.prisma.legoSet.count(),
      this.prisma.legoSet.count({
        where: { OR: [{ ean: { not: null } }, { upc: { not: null } }] },
      }),
    ]);
    return { total, withBarcode };
  }

  /**
   * Upsert d'un lot Rebrickable. Ne touche jamais `ean`/`upc` : Rebrickable ne les connait pas,
   * et un `update` naif y ecraserait le travail du moissonnage Brickset.
   */
  async upsertFromRebrickable(sets: RebrickableSet[]): Promise<number> {
    let written = 0;
    for (const s of sets) {
      const data = {
        name: s.name,
        year: s.year ?? null,
        themeId: s.theme_id ?? null,
        numParts: s.num_parts ?? null,
        imageUrl: s.set_img_url ?? null,
      };
      await this.prisma.legoSet.upsert({
        where: { setNum: s.set_num },
        create: { setNum: s.set_num, ...data, sources: 'rebrickable' },
        update: data,
      });
      written++;
    }
    return written;
  }

  /**
   * Upsert d'un lot Brickset. Ne porte que ce que Brickset apporte reellement : les codes-barres,
   * et l'identifiant Brickset pour rejouer un rapprochement. Le nom, l'annee et le theme restent
   * ceux de Rebrickable - avoir deux sources qui se disputent le meme champ ferait osciller la
   * ligne a chaque moissonnage.
   *
   * La jointure se fait sur `number` + `numberVariant` -> `set_num` Rebrickable ("42131" + 1 =
   * "42131-1"). Une ligne Brickset sans correspondance Rebrickable est **creee** : c'est le cas
   * des nouveautes, que Brickset reference souvent en premier.
   */
  async upsertFromBrickset(sets: BricksetSet[]): Promise<number> {
    let written = 0;
    for (const s of sets) {
      const setNum = bricksetSetNum(s);
      if (!setNum) continue;

      const ean = s.barcode?.EAN ? normalizeBarcode(s.barcode.EAN) : null;
      const upc = s.barcode?.UPC ? normalizeBarcode(s.barcode.UPC) : null;
      if (!ean && !upc) continue;

      const existing = await this.prisma.legoSet.findUnique({
        where: { setNum },
        select: { sources: true },
      });

      await this.prisma.legoSet.upsert({
        where: { setNum },
        create: {
          setNum,
          name: s.name,
          year: s.year ?? null,
          themeId: null,
          numParts: s.pieces ?? null,
          imageUrl: s.image?.imageURL ?? s.image?.thumbnailURL ?? null,
          ean,
          upc,
          bricksetId: s.setID,
          sources: 'brickset',
        },
        update: {
          ean,
          upc,
          bricksetId: s.setID,
          sources: mergeSources(existing?.sources, 'brickset'),
        },
      });
      written++;
    }
    return written;
  }

  /** Projection vers la forme unifiee servie par l'API. */
  async toUnified(
    row: LegoSet,
    source: LegoSourceCode = 'local-index',
  ): Promise<UnifiedLegoSet> {
    const theme =
      row.themeId !== null ? await this.themes.findById(row.themeId) : null;
    const [setNumber] = row.setNum.split('-');
    return {
      source,
      sourceId: row.setNum,
      mediaType: 'lego',
      title: row.name,
      creators: [],
      releaseDate: row.year ? String(row.year) : undefined,
      coverUrl: row.imageUrl ?? undefined,
      metadata: {
        setNum: row.setNum,
        setNumber,
        theme: {
          id: row.themeId,
          name: theme?.name ?? null,
          path: theme?.path ?? null,
        },
        numParts: row.numParts,
        minifigs: null,
        barcodes: { ean: row.ean, upc: row.upc },
        contributedBy: row.sources.split('+') as LegoSourceCode[],
      },
      rawData: row,
    };
  }

  async toUnifiedMany(rows: LegoSet[]): Promise<UnifiedLegoSet[]> {
    return Promise.all(rows.map((r) => this.toUnified(r)));
  }

  logSummary(counts: { total: number; withBarcode: number }): void {
    const pct =
      counts.total === 0
        ? 0
        : Math.round((counts.withBarcode / counts.total) * 100);
    this.logger.log(
      `index: ${counts.total} sets, ${counts.withBarcode} avec code-barres (${pct}%)`,
    );
  }
}

/** "42131" + variante 1 -> "42131-1", la forme canonique cote Rebrickable. */
export function bricksetSetNum(s: BricksetSet): string | null {
  if (!s.number) return null;
  const variant = s.numberVariant && s.numberVariant > 0 ? s.numberVariant : 1;
  return `${s.number}-${variant}`;
}

function mergeSources(existing: string | undefined, added: string): string {
  const parts = new Set((existing ?? '').split('+').filter(Boolean));
  parts.add(added);
  return [...parts].sort().join('+');
}
