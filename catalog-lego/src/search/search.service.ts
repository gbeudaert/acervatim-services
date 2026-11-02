import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SourceTokenRequiredException } from '../common/sources/source-token-required.exception';
import { RebrickableService } from '../common/sources/rebrickable/rebrickable.service';
import { SetIndexService } from '../common/sources/set-index/set-index.service';
import {
  ThemeNode,
  ThemeSyncService,
} from '../common/sources/set-index/theme-sync.service';
import { RebrickableSet } from '../common/sources/rebrickable/rebrickable.types';
import { LegoSourceCode, UnifiedLegoSet } from '../common/sources/types';
import { Principal } from '../common/guards/principal.types';

/**
 * Reponse paginee. `meta.pagination` est le contrat commun (contrats-api-v1.md) ; `meta.source`
 * est une extension additive qui dit **qui a repondu** - l'index local ou la source en ligne.
 * Sans elle, un resultat pauvre servi en mode degrade serait indiscernable d'un catalogue vide.
 */
export interface LegoSearchPage {
  data: UnifiedLegoSet[];
  meta: {
    pagination: { nextCursor: string | null; limit: number };
    source: LegoSourceCode;
    degraded: boolean;
  };
}

interface Cursor {
  /** Page 1-base chez Rebrickable. */
  p?: number;
  /** Offset dans l'index local. */
  o?: number;
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly rebrickable: RebrickableService,
    private readonly index: SetIndexService,
    private readonly themes: ThemeSyncService,
  ) {}

  async search(
    principal: Principal,
    query: {
      q?: string;
      barcode?: string;
      theme?: string;
      cursor?: string;
      limit: number;
    },
  ): Promise<LegoSearchPage> {
    if (query.barcode) {
      return this.byBarcode(query.barcode, query.limit);
    }
    if (query.theme) {
      return this.byTheme(principal, query.theme, query);
    }
    return this.byName(principal, query.q!, query);
  }

  /**
   * Scan. **Toujours** servi par l'index local, jamais par une source en ligne : aucune des API
   * LEGO gratuites n'expose une recherche par code-barres (cf. `SetIndexService`). C'est une
   * limite du paysage des sources, pas un choix de mise en cache - d'ou l'absence totale de
   * repli reseau ici.
   */
  private async byBarcode(
    barcode: string,
    limit: number,
  ): Promise<LegoSearchPage> {
    const rows = await this.index.findByBarcode(barcode);
    const data = await this.index.toUnifiedMany(rows.slice(0, limit));
    return {
      data,
      meta: {
        pagination: { nextCursor: null, limit },
        source: 'local-index',
        degraded: false,
      },
    };
  }

  /**
   * Filtre par type de set. Servi par l'index local, et ce n'est pas un repli : le `theme_id` de
   * Rebrickable est un filtre **exact**, alors qu'un utilisateur qui demande "technic" attend
   * aussi les trente sous-themes. Seul l'index, qui porte l'arbre, sait repondre a la question
   * posee. Tant qu'il est vide, on retombe sur la source avec le theme exact - resultat partiel,
   * signale par `degraded`.
   */
  private async byTheme(
    principal: Principal,
    themeInput: string,
    query: { q?: string; cursor?: string; limit: number },
  ): Promise<LegoSearchPage> {
    const theme = this.themes.resolve(themeInput);
    if (!theme) {
      throw new NotFoundException(`Unknown theme: ${themeInput}`);
    }

    const indexed = await this.index.count();
    if (indexed.total === 0) {
      return this.fromRebrickable(principal, query, theme.id, true);
    }

    const offset = decodeCursor(query.cursor).o ?? 0;
    const rows = await this.index.searchByName(
      query.q ?? '',
      this.themes.descendantIds(theme.id),
      offset,
      query.limit + 1,
    );
    return this.localPage(rows, offset, query.limit, false);
  }

  /**
   * Recherche texte. Rebrickable d'abord (catalogue complet et a jour), index local en repli
   * quand aucun jeton n'est utilisable - c'est exactement le mode degrade du monolithe : on sert
   * ce qu'on peut servir sans cle, et on ne leve la 403 typee que si on n'a vraiment rien.
   */
  private async byName(
    principal: Principal,
    q: string,
    query: { cursor?: string; limit: number },
  ): Promise<LegoSearchPage> {
    try {
      return await this.fromRebrickable(
        principal,
        { ...query, q },
        undefined,
        false,
      );
    } catch (err) {
      if (!(err instanceof SourceTokenRequiredException)) throw err;

      const offset = decodeCursor(query.cursor).o ?? 0;
      const rows = await this.index.searchByName(
        q,
        undefined,
        offset,
        query.limit + 1,
      );
      if (rows.length === 0 && offset === 0) {
        // Rien en ligne, rien en local : l'appelant doit connecter une cle ou passer premium.
        throw err;
      }
      this.logger.log(
        `search degrade sur l index local (aucun jeton rebrickable) q="${q}"`,
      );
      return this.localPage(rows, offset, query.limit, true);
    }
  }

  private async fromRebrickable(
    principal: Principal,
    query: { q?: string; cursor?: string; limit: number },
    themeId: number | undefined,
    degraded: boolean,
  ): Promise<LegoSearchPage> {
    const page = decodeCursor(query.cursor).p ?? 1;
    const res = await this.rebrickable.searchSets(
      { userId: principal.userId, premium: principal.premium },
      { q: query.q, themeId, page, pageSize: query.limit },
    );

    // Effet de bord voulu : toute recherche enrichit l'index. Le catalogue se remplit donc au
    // fil de l'usage meme si le moissonnage nocturne n'a jamais tourne.
    await this.index.upsertFromRebrickable(res.results);

    return {
      data: await Promise.all(
        res.results.map((s) => this.mapRebrickable(s, 'rebrickable')),
      ),
      meta: {
        pagination: {
          nextCursor: res.next ? encodeCursor({ p: page + 1 }) : null,
          limit: query.limit,
        },
        source: 'rebrickable',
        degraded,
      },
    };
  }

  private async localPage(
    rows: Awaited<ReturnType<SetIndexService['searchByName']>>,
    offset: number,
    limit: number,
    degraded: boolean,
  ): Promise<LegoSearchPage> {
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      data: await this.index.toUnifiedMany(page),
      meta: {
        pagination: {
          nextCursor: hasMore ? encodeCursor({ o: offset + limit }) : null,
          limit,
        },
        source: 'local-index',
        degraded,
      },
    };
  }

  /** Detail d'un set : index local d'abord (gratuit), source en ligne sinon. */
  async getSet(principal: Principal, setNum: string): Promise<UnifiedLegoSet> {
    const local = await this.index.findBySetNum(setNum);
    if (local) return this.index.toUnified(local);

    const remote = await this.rebrickable.getSet(
      { userId: principal.userId, premium: principal.premium },
      setNum,
    );
    await this.index.upsertFromRebrickable([remote]);
    return this.mapRebrickable(remote, 'rebrickable');
  }

  /** Arbre des types de set expose a l'app. `parent` absent = les themes de tete. */
  listThemes(parent?: string): ThemeNode[] {
    if (!parent) return this.themes.topLevel();
    const node = this.themes.resolve(parent);
    if (!node) throw new NotFoundException(`Unknown theme: ${parent}`);
    return this.themes.children(node.id);
  }

  private async mapRebrickable(
    s: RebrickableSet,
    source: LegoSourceCode,
  ): Promise<UnifiedLegoSet> {
    const theme = s.theme_id !== null ? this.themes.findById(s.theme_id) : null;
    const [setNumber] = s.set_num.split('-');
    // Les codes-barres ne viennent jamais de Rebrickable : on les relit dans l'index, ou le
    // moissonnage Brickset a pu les deposer.
    const indexed = await this.index.findBySetNum(s.set_num);
    return {
      source,
      sourceId: s.set_num,
      mediaType: 'lego',
      title: s.name,
      creators: [],
      releaseDate: s.year ? String(s.year) : undefined,
      coverUrl: s.set_img_url ?? undefined,
      metadata: {
        setNum: s.set_num,
        setNumber,
        theme: {
          id: s.theme_id,
          name: theme?.name ?? null,
          path: theme?.path ?? null,
        },
        numParts: s.num_parts,
        minifigs: null,
        barcodes: {
          ean: indexed?.ean ?? null,
          upc: indexed?.upc ?? null,
        },
        contributedBy: indexed
          ? (indexed.sources.split('+') as LegoSourceCode[])
          : ['rebrickable'],
      },
      rawData: s,
    };
  }
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

/** Un curseur illisible n'est pas une erreur cliente utile : on repart du debut. */
function decodeCursor(raw: string | undefined): Cursor {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    );
    if (!parsed || typeof parsed !== 'object') return {};
    const c = parsed as Cursor;
    return {
      p: typeof c.p === 'number' && c.p > 0 ? c.p : undefined,
      o: typeof c.o === 'number' && c.o >= 0 ? c.o : undefined,
    };
  } catch {
    return {};
  }
}
