import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { parse } from 'csv-parse';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { ReadableStream as NodeReadableStream } from 'stream/web';
import { createGunzip } from 'zlib';
import { CatalogService } from '../catalog/catalog.service';
import {
  buildThemeTree,
  RawTheme,
  ThemeNode,
  uniqueSlug,
} from '../catalog/theme-tree';
import { PrismaService } from '../prisma/prisma.service';

export const REBRICKABLE_SOURCE = 'rebrickable';

/** Le fichier dont le `Last-Modified` decide s'il y a lieu d'importer. */
const SETS_FILE = 'sets.csv.gz';
const THEMES_FILE = 'themes.csv.gz';
const INVENTORIES_FILE = 'inventories.csv.gz';
const INVENTORY_MINIFIGS_FILE = 'inventory_minifigs.csv.gz';

/** Colonnes attendues : un CSV qui ne les porte plus a change de format, on s'arrete. */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  [SETS_FILE]: ['set_num', 'name', 'year', 'theme_id', 'num_parts', 'img_url'],
  [THEMES_FILE]: ['id', 'name', 'parent_id'],
  [INVENTORIES_FILE]: ['id', 'version', 'set_num'],
  [INVENTORY_MINIFIGS_FILE]: ['inventory_id', 'fig_num', 'quantity'],
};

/** 1 000 lignes x 7 parametres : loin du plafond de 65 535 parametres lies de MariaDB. */
const BATCH_SIZE = 1000;
/** Par fichier, telechargement ET lecture compris (le flux reste ouvert pendant l'ecriture). */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/** Largeurs des colonnes de `lego_sets`. */
const SET_NUM_MAX = 32;
const NAME_MAX = 512;
const IMAGE_URL_MAX = 1024;
const THEME_NAME_MAX = 255;

export type ImportState = 'done' | 'unchanged' | 'failed';

export interface ImportReport {
  runId: string;
  state: ImportState;
  mode: 'full' | 'forced';
  /** `Last-Modified` de `sets.csv.gz`, ISO 8601. */
  lastModified: string | null;
  themes: number;
  rowsUpserted: number;
  skipped: number;
  durationMs: number;
  lastError?: string;
}

interface SetRow {
  setNum: string;
  name: string;
  year: number | null;
  themeId: number | null;
  numParts: number | null;
  minifigs: number | null;
  imageUrl: string | null;
}

type CsvRecord = Record<string, string | undefined>;

/**
 * Import quotidien des CSV publics Rebrickable (page Downloads).
 *
 * C'est la **seule** automatisation vers Rebrickable : la documentation de l'API impose les CSV
 * pour un catalogue complet, et les CGU (5.3) n'autorisent l'automatisation que pour cette page.
 * Aucun appel a l'API, aucune image telechargee - `img_url` est stockee telle quelle.
 *
 * Deroulement, en flux (gunzip puis `csv-parse` en mode colonnes) :
 *  1. `HEAD sets.csv.gz` : meme `Last-Modified` que le dernier import `done` -> rien n'est
 *     telecharge, run `unchanged` (sauf `force`). HEAD refuse : import sans controle ;
 *  2. themes : arbre complet recalcule (path, depth, slug), upsert, themes absents marques
 *     retires ;
 *  3. carte des figurines : inventaire de plus petite version de chaque set, somme des
 *     quantites de `inventory_minifigs` ;
 *  4. sets par lots `INSERT ... ON DUPLICATE KEY UPDATE`, **sans** `ean`, `upc` ni
 *     `brickset_id` - ces colonnes appartiennent au moissonnage Brickset.
 *
 * Un fichier `themes`, `inventories` ou `sets` qui ne donne aucune ligne fait echouer le run :
 * un CSV valide mais vide n'est pas un catalogue vide, c'est une publication ratee.
 *
 * Un set absent du CSV n'est jamais supprime : une reference retiree chez Rebrickable reste
 * resolvable pour l'utilisateur qui la possede.
 *
 * Declenche par le passage quotidien (`DailyRefreshService`, 03:00 UTC), au demarrage si le
 * catalogue est vide, et par `POST /admin/import/rebrickable`.
 */
@Injectable()
export class RebrickableCsvService implements OnModuleInit {
  private readonly logger = new Logger(RebrickableCsvService.name);
  private baseUrl!: string;
  private userAgent!: string;
  /**
   * Single-flight **intra-processus** : un import demande pendant qu'un autre tourne se rattache
   * a celui-ci. Suffisant tant que le service tourne en un exemplaire - c'est le cas, et un
   * verrou multi-replicas n'est pas souhaite.
   */
  private inflight: Promise<ImportReport> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly catalog: CatalogService,
  ) {}

  onModuleInit(): void {
    this.baseUrl = this.config
      .get<string>('REBRICKABLE_DOWNLOADS_URL')!
      .replace(/\/+$/, '');
    this.userAgent = this.config.get<string>('HTTP_USER_AGENT')!;
  }

  run(opts: { force?: boolean } = {}): Promise<ImportReport> {
    if (this.inflight) {
      this.logger.warn('import deja en cours : rattache a celui-ci');
      return this.inflight;
    }
    this.inflight = this.execute(Boolean(opts.force)).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async execute(force: boolean): Promise<ImportReport> {
    const startedAt = Date.now();
    const mode = force ? 'forced' : 'full';
    await this.closeInterruptedRuns();
    const run = await this.prisma.importRun.create({
      data: { source: REBRICKABLE_SOURCE, mode, state: 'running' },
    });

    let lastModified: Date | null = null;
    let themes = 0;
    const progress = { rows: 0, skipped: 0 };
    const report = (state: ImportState, lastError?: string): ImportReport => ({
      runId: run.id,
      state,
      mode,
      lastModified: lastModified?.toISOString() ?? null,
      themes,
      rowsUpserted: progress.rows,
      skipped: progress.skipped,
      durationMs: Date.now() - startedAt,
      ...(lastError ? { lastError } : {}),
    });

    try {
      lastModified = await this.headLastModified(SETS_FILE);
      if (!force && lastModified) {
        const lastDone = await this.prisma.importRun.findFirst({
          where: { source: REBRICKABLE_SOURCE, state: 'done' },
          orderBy: { finishedAt: 'desc' },
        });
        if (lastDone?.watermark?.getTime() === lastModified.getTime()) {
          await this.finishRun(run.id, 'unchanged', {
            watermark: lastModified,
          });
          this.logger.log(
            `import: ${SETS_FILE} inchange depuis ${lastModified.toISOString()}`,
          );
          return report('unchanged');
        }
      }

      themes = await this.importThemes();
      const minifigs = await this.minifigCounts();
      // Le filigrane retenu est celui du fichier reellement lu, pas celui du HEAD : il peut
      // avoir ete republie entre les deux.
      lastModified =
        (await this.importSets(minifigs, progress)) ?? lastModified;

      await this.finishRun(run.id, 'done', {
        watermark: lastModified,
        rowsUpserted: progress.rows,
      });
      this.logger.log(
        `import: ${progress.rows} sets, ${themes} themes (${progress.skipped} lignes ignorees)`,
      );
      return report('done');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`import: echec - ${message}`);
      // Les lots deja ecrits restent : ils sont a jour, l'import suivant completera.
      await this.finishRun(run.id, 'failed', {
        lastError: message,
        rowsUpserted: progress.rows,
      }).catch((e: unknown) =>
        this.logger.error(
          `import: run ${run.id} non cloture - ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
      return report('failed', message);
    }
  }

  /**
   * `Last-Modified` de `sets.csv.gz`, ou `null`. Un HEAD refuse (403, 405...) ou injoignable ne
   * fait pas echouer l'import : on journalise et on telecharge sans controle conditionnel. Sans
   * cela, un CDN qui cesserait d'accepter HEAD bloquerait tous les imports.
   */
  private async headLastModified(file: string): Promise<Date | null> {
    try {
      const res = await this.fetchFile(file, 'HEAD');
      return parseHttpDate(res.headers.get('last-modified'));
    } catch (err) {
      this.logger.warn(
        `import: HEAD ${file} refuse (${err instanceof Error ? err.message : String(err)}) - telechargement sans controle Last-Modified`,
      );
      return null;
    }
  }

  /**
   * Un run reste `running` si le processus s'est arrete en cours d'import. Le single-flight
   * garantit qu'aucun autre import ne tourne ici : un tel run est donc orphelin.
   */
  private async closeInterruptedRuns(): Promise<void> {
    await this.prisma.importRun.updateMany({
      where: { source: REBRICKABLE_SOURCE, state: 'running' },
      data: {
        state: 'failed',
        finishedAt: new Date(),
        lastError: 'interrompu (arret du processus pendant l import)',
      },
    });
  }

  // ------------------------------------------------------------------ themes

  private async importThemes(): Promise<number> {
    const raw: RawTheme[] = [];
    await this.eachRecord(THEMES_FILE, (rec) => {
      const id = toInt(rec.id);
      if (id === null) return;
      raw.push({
        id,
        name: (rec.name ?? '').slice(0, THEME_NAME_MAX),
        parentId: toInt(rec.parent_id),
      });
    });
    if (raw.length === 0) throw new Error(`${THEMES_FILE}: aucun theme`);

    const nodes = buildThemeTree(raw);
    await this.writeThemes(nodes);
    await this.catalog.reloadThemes();
    return nodes.length;
  }

  /**
   * Upsert de l'arbre complet, dans une transaction.
   *
   * `slug` est unique, et un `ON DUPLICATE KEY UPDATE` se declenche sur **n'importe quelle** cle
   * unique : si le slug voulu par un theme est encore tenu par un autre, l'insertion mettrait a
   * jour la mauvaise ligne. On libere donc d'abord les slugs convoites :
   *  - theme encore publie : slug provisoire `#{id}`, ecrase par l'upsert ;
   *  - theme retire du CSV : premier slug libre parmi `{slug}-{id}`, `{slug}-{id}-2`... verifie
   *    contre les slugs voulus ET existants - une collision violerait l'index unique et ferait
   *    echouer tous les imports suivants.
   *
   * Les themes absents du CSV sont marques `retired_at` (jamais supprimes : des sets les
   * referencent) ; un theme qui reparait est remis a `NULL` par l'upsert.
   */
  private async writeThemes(nodes: ThemeNode[]): Promise<void> {
    const wanted = new Map(nodes.map((n) => [n.id, n.slug]));
    const wantedSlugs = new Set(wanted.values());

    await this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.legoTheme.findMany({
          select: { id: true, slug: true },
        });
        const taken = new Set([...wantedSlugs, ...existing.map((r) => r.slug)]);
        for (const row of existing) {
          const own = wanted.get(row.id);
          if (own === row.slug || !wantedSlugs.has(row.slug)) continue;
          const slug =
            own !== undefined
              ? `#${row.id}`
              : uniqueSlug(row.slug, row.id, (c) => taken.has(c));
          taken.add(slug);
          await tx.legoTheme.update({ where: { id: row.id }, data: { slug } });
        }

        for (const chunk of chunks(nodes, BATCH_SIZE)) {
          const values = chunk.map(
            (n) =>
              Prisma.sql`(${n.id}, ${n.name}, ${n.slug}, ${n.parentId}, ${n.path}, ${n.depth}, NULL)`,
          );
          await tx.$executeRaw`
            INSERT INTO lego_themes (id, name, slug, parent_id, path, depth, retired_at)
            VALUES ${Prisma.join(values)}
            ON DUPLICATE KEY UPDATE
              name = VALUES(name),
              slug = VALUES(slug),
              parent_id = VALUES(parent_id),
              path = VALUES(path),
              depth = VALUES(depth),
              retired_at = NULL`;
        }

        await tx.legoTheme.updateMany({
          where: { id: { notIn: [...wanted.keys()] }, retiredAt: null },
          data: { retiredAt: new Date() },
        });
      },
      { timeout: 60_000 },
    );
  }

  // ------------------------------------------------------------------ figurines

  /**
   * `set_num -> nombre de figurines`. Un set a plusieurs inventaires (une version par
   * correction) : on retient celui de **plus petite version**, et on somme ses quantites. Un set
   * dont cet inventaire n'a aucune figurine vaut `0` ; un set sans inventaire est absent de la
   * carte (donc `null`).
   */
  private async minifigCounts(): Promise<Map<string, number>> {
    const smallest = new Map<
      string,
      { version: number; inventoryId: number }
    >();
    let inventories = 0;
    await this.eachRecord(INVENTORIES_FILE, (rec) => {
      const inventoryId = toInt(rec.id);
      const version = toInt(rec.version);
      const setNum = rec.set_num;
      if (inventoryId === null || version === null || !setNum) return;
      inventories++;
      const current = smallest.get(setNum);
      if (
        !current ||
        version < current.version ||
        (version === current.version && inventoryId < current.inventoryId)
      ) {
        smallest.set(setNum, { version, inventoryId });
      }
    });

    // Garde de coherence : un fichier valide mais vide passerait toutes les figurines a NULL et
    // clorait le run en `done`. Un catalogue sans inventaire n'existe pas.
    if (inventories === 0) {
      throw new Error(`${INVENTORIES_FILE}: aucun inventaire`);
    }

    const setByInventory = new Map<number, string>();
    const counts = new Map<string, number>();
    for (const [setNum, { inventoryId }] of smallest) {
      setByInventory.set(inventoryId, setNum);
      counts.set(setNum, 0);
    }

    await this.eachRecord(INVENTORY_MINIFIGS_FILE, (rec) => {
      const inventoryId = toInt(rec.inventory_id);
      const quantity = toInt(rec.quantity);
      if (inventoryId === null || quantity === null) return;
      const setNum = setByInventory.get(inventoryId);
      if (setNum === undefined) return;
      counts.set(setNum, counts.get(setNum)! + quantity);
    });
    return counts;
  }

  // ------------------------------------------------------------------ sets

  /** Renvoie le `Last-Modified` du fichier lu. */
  private async importSets(
    minifigs: Map<string, number>,
    progress: { rows: number; skipped: number },
  ): Promise<Date | null> {
    let batch: SetRow[] = [];
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const rows = batch;
      batch = [];
      await this.writeSets(rows);
      progress.rows += rows.length;
    };

    const lastModified = await this.eachRecord(SETS_FILE, async (rec) => {
      const row = toSetRow(rec, minifigs);
      if (!row) {
        progress.skipped++;
        return;
      }
      batch.push(row);
      if (batch.length >= BATCH_SIZE) await flush();
    });
    await flush();
    if (progress.rows === 0) throw new Error(`${SETS_FILE}: aucun set`);
    return lastModified;
  }

  /**
   * `ean`, `upc` et `brickset_id` ne figurent ni dans l'insertion ni dans la mise a jour : un
   * set cree ici les a `NULL`, un set existant garde ce que Brickset y a depose.
   *
   * `updated_at` n'avance que si une valeur change. Les affectations d'un `ON DUPLICATE KEY
   * UPDATE` s'evaluent de gauche a droite : placee en tete, la comparaison voit encore
   * l'ancienne ligne.
   */
  private async writeSets(rows: SetRow[]): Promise<void> {
    const values = rows.map(
      (r) =>
        Prisma.sql`(${r.setNum}, ${r.name}, ${r.year}, ${r.themeId}, ${r.numParts}, ${r.minifigs}, ${r.imageUrl}, CURRENT_TIMESTAMP(3))`,
    );
    await this.prisma.$executeRaw`
      INSERT INTO lego_sets
        (set_num, name, year, theme_id, num_parts, minifigs, image_url, updated_at)
      VALUES ${Prisma.join(values)}
      ON DUPLICATE KEY UPDATE
        updated_at = IF(
          BINARY name <=> BINARY VALUES(name)
            AND year <=> VALUES(year)
            AND theme_id <=> VALUES(theme_id)
            AND num_parts <=> VALUES(num_parts)
            AND minifigs <=> VALUES(minifigs)
            AND BINARY image_url <=> BINARY VALUES(image_url),
          updated_at,
          VALUES(updated_at)
        ),
        name = VALUES(name),
        year = VALUES(year),
        theme_id = VALUES(theme_id),
        num_parts = VALUES(num_parts),
        minifigs = VALUES(minifigs),
        image_url = VALUES(image_url)`;
  }

  // ------------------------------------------------------------------ telechargement

  /**
   * Telecharge un CSV gzip et le lit **en flux** : gunzip puis `csv-parse` en mode colonnes.
   * `handle` est attendu ligne a ligne, ce qui propage la contre-pression jusqu'au reseau. Une
   * erreur a n'importe quel etage (HTTP, gzip, CSV, base) detruit tout le pipeline.
   */
  private async eachRecord(
    file: string,
    handle: (rec: CsvRecord) => void | Promise<void>,
  ): Promise<Date | null> {
    const res = await this.fetchFile(file, 'GET');
    if (!res.body) throw new Error(`${file}: reponse sans corps`);
    const lastModified = parseHttpDate(res.headers.get('last-modified'));
    const required = REQUIRED_COLUMNS[file] ?? [];

    await pipeline(
      Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>),
      createGunzip(),
      parse({
        bom: true,
        skip_empty_lines: true,
        columns: (header: string[]) => {
          const missing = required.filter((c) => !header.includes(c));
          if (missing.length > 0) {
            throw new Error(
              `${file}: colonnes absentes (${missing.join(', ')}) - format change ?`,
            );
          }
          return header;
        },
      }),
      async function (records: AsyncIterable<CsvRecord>) {
        for await (const rec of records) await handle(rec);
      },
    );
    return lastModified;
  }

  private async fetchFile(
    file: string,
    method: 'GET' | 'HEAD',
  ): Promise<Response> {
    const url = `${this.baseUrl}/${file}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { 'User-Agent': this.userAgent },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(
        `${file}: injoignable (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`${file}: HTTP ${res.status}`);
    }
    return res;
  }

  private async finishRun(
    id: string,
    state: ImportState,
    extra: {
      watermark?: Date | null;
      rowsUpserted?: number;
      lastError?: string;
    },
  ): Promise<void> {
    await this.prisma.importRun.update({
      where: { id },
      data: { state, finishedAt: new Date(), ...extra },
    });
  }
}

function toSetRow(
  rec: CsvRecord,
  minifigs: Map<string, number>,
): SetRow | null {
  const setNum = (rec.set_num ?? '').trim();
  if (!setNum || setNum.length > SET_NUM_MAX) return null;
  const imageUrl = (rec.img_url ?? '').trim();
  return {
    setNum,
    name: (rec.name ?? '').slice(0, NAME_MAX),
    year: toInt(rec.year),
    themeId: toInt(rec.theme_id),
    numParts: toInt(rec.num_parts),
    minifigs: minifigs.get(setNum) ?? null,
    imageUrl: imageUrl && imageUrl.length <= IMAGE_URL_MAX ? imageUrl : null,
  };
}

/** Entier signe tenant dans un `INT` MariaDB, sinon `null` (champ vide compris). */
function toInt(raw: string | undefined): number | null {
  const value = (raw ?? '').trim();
  if (!/^-?\d{1,10}$/.test(value)) return null;
  const n = Number(value);
  return n >= -2_147_483_648 && n <= 2_147_483_647 ? n : null;
}

function parseHttpDate(raw: string | null): Date | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t);
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}
