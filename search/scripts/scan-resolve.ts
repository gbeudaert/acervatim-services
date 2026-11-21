/**
 * Banc d'essai du scan manga : résout un lot d'ISBN **comme l'app**, avec le code de `search`, et
 * compare au besoin le résultat à un rapport de référence (celui du monolithe, ou un passage
 * précédent de ce script).
 *
 * Pour chaque ISBN, le parcours de l'app (`ImportScannedSeriesUseCase`), sans HTTP ni identité :
 *  1. le scan : `SearchService.search(type=manga, barcode)`, d'où sortent le titre de série
 *     (`scannedTome.seriesTitleFr`), l'édition, l'éditeur et le mangaId ;
 *  2. l'import de la série : `warmEditionMapping` avec ces quatre valeurs, ce que fait le worker
 *     `edition-import` (énumération BnF, jaquettes et résumés) ;
 *  3. la liste des tomes que l'app relit ensuite : `editionMapping`, en cache seul.
 *
 * Le rapport garde les champs du `scan-resolve` du monolithe (`scanResolution`, `series.titleFr`,
 * `series.edition`, `tomes[].cover`) pour que `--compare` lise les deux formats.
 *
 * **Premium non simulé.** Le monolithe créait des utilisateurs premium dans sa base ; ici le premium
 * se résout dans `connections` et `billing`, et la file `mal` est partagée avec le service qui tourne
 * (son worker relit le jeton de l'utilisateur). Le banc scanne donc comme un utilisateur gratuit
 * sans jeton MAL : le repli MAL ne sert que son cache, et un ISBN que MangaDex n'identifie pas finit
 * en `bnf_only` là où un premium aurait pu passer par MAL.
 *
 * Refuse NODE_ENV=production.
 *
 * Usage (dans le conteneur search, pile de dev démarrée) :
 *   ./scripts/dev.ps1 scan-resolve [<fichier.txt>] [--out <r.json>] [--compare <ref.json>]
 *                                  [--concurrency N] [--bnf-attempts N] [--settle-ms N]
 *   défaut fichier : test/fixtures/scanned-isbns.txt
 *   défaut sortie  : <fichier sans .txt>.result.json
 */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readFileSync, writeFileSync } from 'fs';
import { AppModule } from '../src/app.module';
import { UnifiedItem } from '../src/common/internal/contracts';
import {
  EditionMappingResponse,
  SearchService,
} from '../src/search/search.service';
import { BnfService } from '../src/sources/bnf/bnf.service';
import { BnfResolution } from '../src/sources/bnf/bnf.types';
import { CoverStatus } from '../src/sources/googlebooks/googlebooks.types';
import { MangaDexIdentity } from '../src/sources/mangadex/mangadex.types';

const DEFAULT_INPUT = 'test/fixtures/scanned-isbns.txt';
// Concurrence bornée au niveau ISBN : assez pour simuler des scans simultanés, pas au point de
// dépasser les attentes côté client des files (BnF 20 s, Google 15 s).
const DEFAULT_ISBN_CONCURRENCY = 3;
// Les échecs BnF sous charge sont transitoires et non cachés : on retente. `bnf_not_found` est
// terminal (le scan passe alors par Google Books).
const DEFAULT_BNF_ATTEMPTS = 6;
// Jaquettes encore `unresolved` (503 Google en vagues) : nouvelles passes dans ce budget.
const DEFAULT_SETTLE_MS = 240_000;
// Utilisateur inconnu de `connections` : scan gratuit, sans jeton (cf. en-tête).
const SCAN_USER_ID = '00000000-0000-4000-8000-5ca17e5e0001';

const log = new Logger('scan-resolve');

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------
// Rapport.
// --------------------------------------------------------------------------
interface TomeResult {
  editionVolume: number | null;
  isbn: string | null;
  titleFr: string | null;
  isScanned: boolean;
  /** Tome scanné absent de la liste BnF, ajouté comme le fait l'app (cf. {@link addScannedTome}). */
  fromScan?: boolean;
  cover: {
    found: boolean;
    url: string | null;
    status: CoverStatus;
    /** `null` aussi pour le tome ajouté depuis le scan : sa jaquette est celle de l'item. */
    source: 'mangadex' | 'google_books' | null;
  };
  summary: { found: boolean };
}

interface IsbnResult {
  isbn: string;
  /** `metadata.pivot.resolutionPath` du scan, `not_found` sans item. */
  scanResolution: string;
  /** Source de l'item rendu par le scan (mangadex, mal, bnf, google_books…). */
  identificationSource: string | null;
  collectionFound: boolean;
  malMatched: boolean;
  synopsisLang: 'fr' | 'en' | null;
  confidence: number | null;
  series: {
    /** Titre de série que l'app donne à la série et rejoue dans l'import (`seriesTitleFr`). */
    titleFr: string | null;
    edition: string | null;
    publisher: string | null;
    mangaId: string | null;
    malId: string | null;
    /** Titre d'affichage de l'item (MangaDex, MAL ou BnF). */
    displayTitle: string;
    /** Titre propre du tome scanné (200$a ou titre Google) et son n°. */
    scannedTitleFr: string | null;
    scannedVolume: string | null;
  } | null;
  enumeration: {
    tomeCount: number;
    publisher: string | null;
    recordsScanned: number;
    ongoing: boolean;
    complete: boolean;
    scannedTomeFound: boolean;
  } | null;
  tomes: TomeResult[];
  elapsedMs: number;
  error?: string;
}

interface CompareRow {
  isbn: string;
  differs: boolean;
  resolution: [string | null, string];
  seriesTitle: [string | null, string | null];
  edition: [string | null, string | null];
  tomes: [number | null, number];
  covers: [number | null, number];
}

/** Lecture minimale d'un rapport de référence (format monolithe ou de ce script). */
interface ReferenceReport {
  generatedAt?: string;
  isbns: {
    isbn: string;
    scanResolution?: string;
    series?: { titleFr?: string | null; edition?: string | null } | null;
    tomes?: { cover?: { found?: boolean } }[];
  }[];
}

// --------------------------------------------------------------------------
// Utilitaires.
// --------------------------------------------------------------------------

/** ISBN → forme comparable (chiffres + X). */
function normIsbn(s: string | null | undefined): string {
  return (s ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
}

/** Une ISBN par ligne ; lignes `#` et texte après le code ignorés ; dédupliquées. */
function readIsbns(path: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const norm = normIsbn(trimmed.split(/\s+/)[0]);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

/** Applique `fn` avec au plus `limit` exécutions concurrentes (ordre préservé). */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return results;
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i] ?? '';
    else positional.push(argv[i]);
  }
  const input = positional[0] ?? DEFAULT_INPUT;
  const num = (k: string, d: number) =>
    flags[k] ? Math.max(0, Number(flags[k])) : d;
  return {
    input,
    out: flags.out ?? input.replace(/\.txt$/, '') + '.result.json',
    compare: flags.compare ?? null,
    isbnConcurrency: Math.max(1, num('concurrency', DEFAULT_ISBN_CONCURRENCY)),
    bnfAttempts: Math.max(1, num('bnf-attempts', DEFAULT_BNF_ATTEMPTS)),
    settleMs: num('settle-ms', DEFAULT_SETTLE_MS),
  };
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Notice BnF avec nouvelles tentatives sur échec transitoire ; succès et absence sont terminaux. */
async function resolveByIsbnRobust(
  bnf: BnfService,
  isbn: string,
  attempts: number,
): Promise<BnfResolution> {
  let last: BnfResolution = { ok: false, reason: 'bnf_unavailable' };
  for (let i = 0; i < attempts; i++) {
    last = await bnf.resolveByIsbn(isbn);
    if (last.ok || last.reason === 'bnf_not_found') return last;
    if (i < attempts - 1) await sleep(500 * Math.min(16, 2 ** i));
  }
  return last;
}

interface ImportArgs {
  title: string;
  edition?: string;
  malId?: string;
  mangaId?: string;
  publisher?: string;
}

/**
 * Import de la série (worker `edition-import`) avec nouvelles tentatives tant que l'énumération est
 * tronquée (page SRU en échec) : les pages lues sont en cache, une tentative ne relit que la manquante.
 */
async function importRobust(
  search: SearchService,
  a: ImportArgs,
  attempts: number,
): Promise<EditionMappingResponse> {
  let best: EditionMappingResponse | null = null;
  let lastError: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const m = await search.warmEditionMapping(
        a.title,
        a.edition,
        undefined,
        a.malId,
        a.mangaId,
        a.publisher,
      );
      if (!best || m.tomeCount > best.tomeCount) best = m;
      if (m.complete) return m;
    } catch (err) {
      lastError = err;
    }
    if (i < attempts - 1) await sleep(500 * Math.min(8, i + 1));
  }
  if (best) return best;
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Ce que l'app relit après l'import : `edition-mapping`, en cache seul. */
async function readMapping(
  search: SearchService,
  a: ImportArgs,
): Promise<EditionMappingResponse> {
  return search.editionMapping(a.title, a.edition, a.malId, a.mangaId, {
    publisher: a.publisher,
  });
}

function toTomes(m: EditionMappingResponse, scanned: string): TomeResult[] {
  return m.tomes.map((t) => ({
    editionVolume: t.editionVolume,
    isbn: t.isbn,
    titleFr: t.titleFr,
    isScanned: !!t.isbn && normIsbn(t.isbn) === scanned,
    cover: {
      found: t.coverStatus === 'found',
      url: t.coverUrl,
      status: t.coverStatus,
      source: t.coverSource,
    },
    summary: { found: !!t.description },
  }));
}

/**
 * L'app importe toujours le tome scanné, même absent de la liste BnF (notice sans n° de tome, ISBN
 * d'un retirage, notice inconnue de la BnF) : on l'ajoute de même, pour compter les tomes comme elle
 * et comme le banc du monolithe. Sa jaquette est celle de l'item rendu par le scan.
 */
function addScannedTome(r: IsbnResult, scanCover: string | null): void {
  if (!r.collectionFound || r.tomes.some((t) => t.isScanned)) return;
  const digits = r.series?.scannedVolume?.match(/\d+/)?.[0];
  r.tomes.push({
    editionVolume: digits ? Number(digits) : null,
    isbn: r.isbn,
    titleFr: r.series?.scannedTitleFr ?? null,
    isScanned: true,
    fromScan: true,
    cover: {
      found: !!scanCover,
      url: scanCover,
      status: scanCover ? 'found' : 'absent',
      source: null,
    },
    summary: { found: false },
  });
}

function synopsisLang(item: UnifiedItem): 'fr' | 'en' | null {
  if (item.source === 'mangadex') {
    const identity = item.rawData as MangaDexIdentity | null;
    if (identity?.descriptionFr) return 'fr';
    if (identity?.descriptionEn) return 'en';
    return null;
  }
  if (!item.description) return null;
  // MAL n'a pas de synopsis FR ; la note BnF (330$a) et Google Books FR le sont.
  return item.source === 'mal' ? 'en' : 'fr';
}

// --------------------------------------------------------------------------
// Un ISBN.
// --------------------------------------------------------------------------
interface Deps {
  search: SearchService;
  bnf: BnfService;
  bnfAttempts: number;
}

async function resolveOne(
  isbn: string,
  deps: Deps,
): Promise<{
  result: IsbnResult;
  importArgs: ImportArgs | null;
  scanCover: string | null;
}> {
  const startedAt = Date.now();
  let scanCover: string | null = null;
  const result: IsbnResult = {
    isbn,
    scanResolution: 'not_found',
    identificationSource: null,
    collectionFound: false,
    malMatched: false,
    synopsisLang: null,
    confidence: null,
    series: null,
    enumeration: null,
    tomes: [],
    elapsedMs: 0,
  };
  const done = (importArgs: ImportArgs | null = null) => {
    result.elapsedMs = Date.now() - startedAt;
    return { result, importArgs, scanCover };
  };

  try {
    // 0) Notice BnF lue d'abord, avec nouvelles tentatives : le scan la relit ensuite en cache, et
    //    une panne BnF ne se confond pas avec une absence au catalogue.
    const notice = await resolveByIsbnRobust(deps.bnf, isbn, deps.bnfAttempts);
    if (!notice.ok && notice.reason !== 'bnf_not_found') {
      result.error = `bnf indisponible après ${deps.bnfAttempts} tentatives (${notice.reason})`;
      return done();
    }

    // 1) Le scan.
    const page = await deps.search.search(
      SCAN_USER_ID,
      'manga',
      { barcode: isbn },
      undefined,
      10,
    );
    const item = page.data[0];
    if (!item) return done();
    scanCover = item.coverUrl ?? null;

    const meta = item.metadata ?? {};
    const pivot = (meta.pivot ?? {}) as Record<string, unknown>;
    const tome = (meta.scannedTome ?? {}) as Record<string, unknown>;
    const malId =
      str(pivot.malId) ?? (item.source === 'mal' ? item.sourceId : null);

    result.scanResolution = str(pivot.resolutionPath) ?? item.source;
    result.identificationSource = item.source;
    result.collectionFound = true;
    result.malMatched = !!malId;
    result.synopsisLang = synopsisLang(item);
    result.confidence =
      typeof pivot.confidence === 'number' ? pivot.confidence : null;
    result.series = {
      titleFr: str(tome.seriesTitleFr),
      edition: str(tome.edition),
      publisher: str(tome.publisherFr),
      mangaId: str(pivot.mangaId),
      malId,
      displayTitle: item.title,
      scannedTitleFr: str(tome.titleFr),
      scannedVolume: str(tome.volume),
    };

    // 2) L'import de la série, avec ce que l'app envoie. Sans titre de série, l'app n'importe que
    //    le tome scanné.
    if (!result.series.titleFr) return done();
    const importArgs: ImportArgs = {
      title: result.series.titleFr,
      edition: result.series.edition ?? undefined,
      malId: malId ?? undefined,
      mangaId: result.series.mangaId ?? undefined,
      publisher: result.series.publisher ?? undefined,
    };
    const imported = await importRobust(
      deps.search,
      importArgs,
      deps.bnfAttempts,
    );
    result.tomes = toTomes(imported, isbn);
    result.enumeration = {
      tomeCount: imported.tomeCount,
      publisher: imported.publisher,
      recordsScanned: imported.recordsScanned,
      ongoing: imported.ongoing,
      complete: imported.complete,
      scannedTomeFound: result.tomes.some((t) => t.isScanned),
    };
    return done(importArgs);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    return done();
  }
}

/**
 * Nouvelles passes d'import tant qu'il reste des jaquettes `unresolved` (transitoire), dans la limite
 * de `settleMs`. Chaque passe remplit le cache ; seules les séries concernées sont rejouées.
 */
async function settleCovers(
  runs: Awaited<ReturnType<typeof resolveOne>>[],
  search: SearchService,
  settleMs: number,
  attempts: number,
): Promise<void> {
  const started = Date.now();
  const pending = () =>
    runs.filter(
      (r) =>
        r.importArgs &&
        r.result.tomes.some((t) => t.isbn && t.cover.status === 'unresolved'),
    );
  let pass = 0;
  while (Date.now() - started < settleMs) {
    const batch = pending();
    if (batch.length === 0) break;
    pass++;
    log.log(
      `settle passe ${pass} : ${batch.length} série(s) avec des jaquettes non résolues`,
    );
    for (const r of batch) {
      try {
        const m = await importRobust(search, r.importArgs!, attempts);
        r.result.tomes = toTomes(m, r.result.isbn);
      } catch {
        // On garde le résultat précédent ; la passe suivante retentera.
      }
    }
    if (pending().length > 0) await sleep(3000);
  }
  const left = pending().length;
  if (left > 0) {
    log.warn(
      `settle : ${left} série(s) gardent des jaquettes 'unresolved' après ${Math.round((Date.now() - started) / 1000)} s (quota Google)`,
    );
  }
}

// --------------------------------------------------------------------------
// Comparaison à un rapport de référence.
// --------------------------------------------------------------------------
function normTitle(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function compare(
  refPath: string,
  results: IsbnResult[],
): {
  reference: string;
  referenceGeneratedAt: string | null;
  rows: CompareRow[];
  onlyInReference: string[];
} {
  const ref = JSON.parse(readFileSync(refPath, 'utf8')) as ReferenceReport;
  const byIsbn = new Map(ref.isbns.map((r) => [normIsbn(r.isbn), r]));
  const rows = results.map((r): CompareRow => {
    const old = byIsbn.get(r.isbn);
    const oldTomes = old?.tomes ?? null;
    const row: CompareRow = {
      isbn: r.isbn,
      differs: false,
      resolution: [old?.scanResolution ?? null, r.scanResolution],
      seriesTitle: [old?.series?.titleFr ?? null, r.series?.titleFr ?? null],
      edition: [old?.series?.edition ?? null, r.series?.edition ?? null],
      tomes: [oldTomes ? oldTomes.length : null, r.tomes.length],
      covers: [
        oldTomes ? oldTomes.filter((t) => t.cover?.found).length : null,
        r.tomes.filter((t) => t.cover.found).length,
      ],
    };
    row.differs =
      !!old &&
      (row.resolution[0] !== row.resolution[1] ||
        normTitle(row.seriesTitle[0]) !== normTitle(row.seriesTitle[1]) ||
        normTitle(row.edition[0]) !== normTitle(row.edition[1]) ||
        row.tomes[0] !== row.tomes[1] ||
        row.covers[0] !== row.covers[1]);
    return row;
  });
  const here = new Set(results.map((r) => r.isbn));
  return {
    reference: refPath,
    referenceGeneratedAt: ref.generatedAt ?? null,
    rows,
    onlyInReference: [...byIsbn.keys()].filter((i) => !here.has(i)),
  };
}

function logComparison(c: ReturnType<typeof compare>): void {
  const pair = <T>(p: [T | null, T]) =>
    p[0] === p[1] ? `${p[1]}` : `${p[0] ?? '-'} -> ${p[1] ?? '-'}`;
  log.log(
    `comparaison avec ${c.reference} (${c.referenceGeneratedAt ?? 'date inconnue'})`,
  );
  for (const row of c.rows) {
    const known = row.resolution[0] !== null || row.tomes[0] !== null;
    const mark = !known ? 'NOUVEAU' : row.differs ? 'ECART  ' : 'idem   ';
    log.log(
      `${mark} ${row.isbn} | ${pair(row.resolution)} | serie ${pair(row.seriesTitle)}` +
        `${row.edition[0] || row.edition[1] ? ` | edition ${pair(row.edition)}` : ''}` +
        ` | tomes ${pair(row.tomes)} | jaquettes ${pair(row.covers)}`,
    );
  }
  if (c.onlyInReference.length > 0) {
    log.log(`absents de ce passage : ${c.onlyInReference.join(', ')}`);
  }
}

// --------------------------------------------------------------------------
// Main.
// --------------------------------------------------------------------------
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('scan-resolve is disabled when NODE_ENV=production');
  }
  const args = parseArgs(process.argv.slice(2));
  const isbns = readIsbns(args.input);
  if (isbns.length === 0) throw new Error(`no ISBN found in ${args.input}`);
  log.log(
    `résolution de ${isbns.length} ISBN depuis ${args.input} (concurrence=${args.isbnConcurrency}, ` +
      `retry BnF=${args.bnfAttempts}, settle jaquettes<=${Math.round(args.settleMs / 1000)} s, utilisateur gratuit)`,
  );

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const search = app.get(SearchService, { strict: false });
    const bnf = app.get(BnfService, { strict: false });
    const deps: Deps = { search, bnf, bnfAttempts: args.bnfAttempts };

    const startedAt = Date.now();
    let count = 0;
    const runs = await mapWithConcurrency(
      isbns,
      args.isbnConcurrency,
      async (isbn) => {
        const run = await resolveOne(isbn, deps);
        const r = run.result;
        log.log(
          `[${++count}/${isbns.length}] ${isbn} -> ${r.scanResolution} serie="${r.series?.titleFr ?? '-'}" ` +
            `tomes=${r.tomes.length} jaquettes=${r.tomes.filter((t) => t.cover.found).length}` +
            `${r.error ? ' ERR=' + r.error : ''} (${r.elapsedMs} ms)`,
        );
        return run;
      },
    );

    await settleCovers(runs, search, args.settleMs, args.bnfAttempts);

    // 3) Ce que l'app relit : `edition-mapping` en cache seul, après l'import ; puis le tome scanné
    //    s'il manque à la liste, comme l'app l'ajoute.
    for (const run of runs) {
      if (run.importArgs) {
        try {
          const m = await readMapping(search, run.importArgs);
          run.result.tomes = toTomes(m, run.result.isbn);
          if (run.result.enumeration) {
            run.result.enumeration.tomeCount = m.tomeCount;
            run.result.enumeration.scannedTomeFound = run.result.tomes.some(
              (t) => t.isScanned,
            );
          }
        } catch (err) {
          run.result.error = `edition-mapping: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      addScannedTome(run.result, run.scanCover);
    }

    const results = runs.map((r) => r.result);
    const sum = (f: (r: IsbnResult) => number) =>
      results.reduce((n, r) => n + f(r), 0);
    const countIf = (f: (r: IsbnResult) => boolean) => results.filter(f).length;
    const report = {
      generatedAt: new Date().toISOString(),
      runner: 'constellation/search',
      input: args.input,
      totalMs: Date.now() - startedAt,
      count: results.length,
      summary: {
        collectionFound: countIf((r) => r.collectionFound),
        malMatched: countIf((r) => r.malMatched),
        idMangadex: countIf((r) => r.identificationSource === 'mangadex'),
        idMal: countIf((r) => r.identificationSource === 'mal'),
        idBnfOnly: countIf((r) => r.scanResolution === 'bnf_only'),
        idGoogleBooks: countIf((r) => r.scanResolution.startsWith('gbooks')),
        synopsisFr: countIf((r) => r.synopsisLang === 'fr'),
        synopsisEn: countIf((r) => r.synopsisLang === 'en'),
        notFound: countIf((r) => r.scanResolution === 'not_found'),
        bnfUnavailable: countIf(
          (r) => !!r.error && r.error.startsWith('bnf indisponible'),
        ),
        scannedTomeMissing: countIf(
          (r) => !!r.enumeration && !r.enumeration.scannedTomeFound,
        ),
        tomesTotal: sum((r) => r.tomes.length),
        coversFound: sum((r) => r.tomes.filter((t) => t.cover.found).length),
        coversMangadex: sum(
          (r) => r.tomes.filter((t) => t.cover.source === 'mangadex').length,
        ),
        coversGoogle: sum(
          (r) =>
            r.tomes.filter((t) => t.cover.source === 'google_books').length,
        ),
        coversUnresolved: sum(
          (r) => r.tomes.filter((t) => t.cover.status === 'unresolved').length,
        ),
      },
      comparison: args.compare ? compare(args.compare, results) : null,
      isbns: results,
    };

    writeFileSync(args.out, JSON.stringify(report, null, 2), 'utf8');
    if (report.comparison) logComparison(report.comparison);
    const s = report.summary;
    log.log(
      `terminé en ${report.totalMs} ms - collection ${s.collectionFound}/${report.count}, ` +
        `identification [mangadex ${s.idMangadex}, mal ${s.idMal}, bnf_only ${s.idBnfOnly}, google ${s.idGoogleBooks}], ` +
        `non trouvés ${s.notFound}, bnf indispo ${s.bnfUnavailable}, tome scanné hors liste ${s.scannedTomeMissing}, ` +
        `tomes ${s.tomesTotal}, jaquettes ${s.coversFound} (mangadex ${s.coversMangadex}, google ${s.coversGoogle}, ` +
        `non résolues ${s.coversUnresolved}) - écrit dans ${args.out}`,
    );
  } finally {
    await app.close();
  }
}

main()
  .catch((err) => {
    log.error(err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  })
  // Connexions BullMQ/Redis encore ouvertes après `app.close()` : on n'attend pas leur fin.
  .finally(() => process.exit());
