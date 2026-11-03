import { ConfigService } from '@nestjs/config';
import { gzipSync } from 'zlib';
import { CatalogService } from '../catalog/catalog.service';
import { PrismaService } from '../prisma/prisma.service';
import { RebrickableCsvService } from './rebrickable-csv.service';

const LAST_MODIFIED = 'Sun, 01 Nov 2026 16:53:18 GMT';
const BASE_URL = 'https://cdn.example.test/media/downloads';

/** Extraits reels des CSV Rebrickable, reduits aux cas utiles. */
const CSV: Record<string, string> = {
  'themes.csv.gz': [
    'id,name,parent_id',
    '1,Technic,',
    '3,Competition,1',
    '497,Books,',
    '498,Technic,497',
    '632,Duplo,',
  ].join('\n'),
  'inventories.csv.gz': [
    'id,version,set_num',
    // 42131-1 : la version 1 n'a pas de figurine, la version 4 en aurait.
    '110259,1,42131-1',
    '122910,4,42131-1',
    // 4434-1 : la plus petite version est listee APRES la plus grande.
    '28476,2,4434-1',
    '2293,1,4434-1',
    '84978,1,10952-1',
  ].join('\n'),
  'inventory_minifigs.csv.gz': [
    'inventory_id,fig_num,quantity',
    '122910,fig-000001,3',
    '2293,fig-000002,1',
    '28476,fig-000003,1',
    '28476,fig-000004,1',
  ].join('\n'),
  'sets.csv.gz': [
    'set_num,name,year,theme_id,num_parts,img_url',
    '42131-1,Cat D11 Bulldozer,2021,1,3854,https://cdn.rebrickable.com/media/sets/42131-1.jpg',
    '10952-1,"Barn, Tractor & Farm Animal Care",2021,632,97,https://cdn.rebrickable.com/media/sets/10952-1.jpg',
    '4434-1,Dump Truck,2004,1,128,',
    '9999-1,Sans inventaire,1999,1,10,https://cdn.rebrickable.com/media/sets/9999-1.jpg',
  ].join('\n'),
};

type Run = Record<string, unknown> & {
  id: string;
  source: string;
  state: string;
};

/**
 * `import_runs` en memoire : `updateMany` applique reellement son filtre, ce qui permet de
 * simuler un run orphelin plutot que de constater un appel.
 */
function makeRunStore(initial: Run[] = []) {
  const runs: Run[] = initial.map((r) => ({ ...r }));
  return {
    runs,
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const run = { id: `run-${runs.length + 1}`, ...data } as Run;
      runs.push(run);
      return run;
    }),
    update: jest.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) =>
        Object.assign(
          runs.find((r) => r.id === where.id)!,
          data,
        ),
    ),
    updateMany: jest.fn(
      async ({
        where,
        data,
      }: {
        where: { source: string; state: string };
        data: Record<string, unknown>;
      }) => {
        const hit = runs.filter(
          (r) => r.source === where.source && r.state === where.state,
        );
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
    ),
    findFirst: jest.fn().mockResolvedValue(null),
  };
}

function makePrisma(initialRuns: Run[] = []) {
  const prisma = {
    importRun: makeRunStore(initialRuns),
    legoTheme: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $executeRaw: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
  );
  return prisma;
}

type FakePrisma = ReturnType<typeof makePrisma>;

function makeService(prisma: FakePrisma) {
  const config = {
    get: (key: string) =>
      ({ REBRICKABLE_DOWNLOADS_URL: `${BASE_URL}/`, HTTP_USER_AGENT: 'test' })[
        key
      ],
  } as unknown as ConfigService;
  const catalog = { reloadThemes: jest.fn().mockResolvedValue(undefined) };
  const service = new RebrickableCsvService(
    prisma as unknown as PrismaService,
    config,
    catalog as unknown as CatalogService,
  );
  service.onModuleInit();
  return { service, catalog };
}

/** Copie en `Uint8Array` : le typage DOM de `Response` refuse un `Buffer`. */
function gz(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(gzipSync(Buffer.from(text, 'utf8')));
}

type FileOverride = (file: string, method: string) => Response | undefined;

function mockFetch(override: FileOverride = () => undefined): jest.SpyInstance {
  return jest
    .spyOn(global, 'fetch')
    .mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const file = url.slice(url.lastIndexOf('/') + 1);
      const method = init?.method ?? 'GET';
      const headers = { 'last-modified': LAST_MODIFIED };
      const custom = override(file, method);
      if (custom) return custom;
      if (method === 'HEAD')
        return new Response(null, { status: 200, headers });
      const body = CSV[file];
      if (body === undefined) return new Response(null, { status: 404 });
      return new Response(gz(body), { status: 200, headers });
    });
}

/** Fragment `Prisma.sql` / `Prisma.join` : ses textes et ses parametres lies, aplatis. */
function isSql(p: unknown): p is { strings: string[]; values: unknown[] } {
  return typeof p === 'object' && p !== null && 'strings' in p && 'values' in p;
}

/** Le SQL d'un appel `$executeRaw` tagge, `?` a la place de chaque parametre lie. */
function renderRaw(
  strings: readonly string[],
  params: unknown[],
): { sql: string; values: unknown[] } {
  let sql = strings[0];
  const values: unknown[] = [];
  params.forEach((p, i) => {
    if (isSql(p)) {
      sql += p.strings.join('?');
      values.push(...p.values);
    } else {
      sql += '?';
      values.push(p);
    }
    sql += strings[i + 1];
  });
  return { sql, values };
}

function rawWrites(prisma: FakePrisma, table: string) {
  return prisma.$executeRaw.mock.calls
    .map(([strings, ...params]: [TemplateStringsArray, ...unknown[]]) =>
      renderRaw(strings, params),
    )
    .filter((w: { sql: string }) => w.sql.includes(`INSERT INTO ${table}`));
}

/** Une valeur ecrite en dur dans le SQL (pas un parametre lie). */
interface Literal {
  literal: string;
}

/**
 * Les lignes inserees dans `table`, **chaque valeur rattachee a son nom de colonne SQL** : la
 * liste de colonnes de l'`INSERT` et les tuples de `VALUES` sont relus, et chaque `?` recoit le
 * parametre lie suivant. Un decalage de colonne se voit donc ici, pas seulement un decalage de
 * position.
 */
function insertedRows(
  prisma: FakePrisma,
  table: string,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const { sql, values } of rawWrites(prisma, table)) {
    const columns = /INSERT INTO\s+\w+\s*\(([^)]*)\)/
      .exec(sql)![1]
      .split(',')
      .map((c) => c.trim());
    const tuplesText = sql
      .slice(
        sql.indexOf('VALUES') + 'VALUES'.length,
        sql.indexOf('ON DUPLICATE'),
      )
      .trim()
      .replace(/^\(/, '')
      .replace(/\)$/, '');
    let next = 0;
    for (const tuple of tuplesText.split(/\)\s*,\s*\(/)) {
      const items = tuple.split(',').map((i) => i.trim());
      expect(items).toHaveLength(columns.length);
      const row: Record<string, unknown> = {};
      items.forEach((item, k) => {
        row[columns[k]] =
          item === '?' ? values[next++] : ({ literal: item } as Literal);
      });
      rows.push(row);
    }
    expect(next).toBe(values.length);
  }
  return rows;
}

function bySetNum(prisma: FakePrisma): Map<string, Record<string, unknown>> {
  return new Map(
    insertedRows(prisma, 'lego_sets').map((r) => [r.set_num as string, r]),
  );
}

describe('RebrickableCsvService', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('import nominal', () => {
    it('ecrit themes et sets, et clot le run en done avec ses compteurs', async () => {
      const prisma = makePrisma();
      const { service, catalog } = makeService(prisma);
      mockFetch();

      const report = await service.run();

      expect(report).toMatchObject({
        state: 'done',
        mode: 'full',
        themes: 5,
        rowsUpserted: 4,
        lastModified: new Date(LAST_MODIFIED).toISOString(),
      });
      expect(prisma.importRun.runs.at(-1)).toMatchObject({
        source: 'rebrickable',
        state: 'done',
        rowsUpserted: 4,
        watermark: new Date(LAST_MODIFIED),
      });
      // L'arbre est recharge des que les themes sont ecrits.
      expect(catalog.reloadThemes).toHaveBeenCalled();
    });

    it('ecrit chaque theme colonne par colonne ; le premier id garde le slug nu', async () => {
      const prisma = makePrisma();
      const { service } = makeService(prisma);
      mockFetch();

      await service.run();

      const themes = insertedRows(prisma, 'lego_themes');
      expect(themes[0]).toEqual({
        id: 1,
        name: 'Technic',
        slug: 'technic',
        parent_id: null,
        path: 'Technic',
        depth: 0,
        retired_at: { literal: 'NULL' },
      });
      expect(themes).toContainEqual({
        id: 498,
        name: 'Technic',
        slug: 'technic-498',
        parent_id: 497,
        path: 'Books / Technic',
        depth: 1,
        retired_at: { literal: 'NULL' },
      });
    });

    it('libere d abord les slugs convoites, avant l insertion des themes', async () => {
      const prisma = makePrisma();
      prisma.legoTheme.findMany.mockResolvedValue([
        // Slug que le theme 1 doit recuperer.
        { id: 498, slug: 'technic' },
        { id: 1, slug: 'technic-1' },
        // Theme retire du CSV, mais qui tient le slug d'un theme publie.
        { id: 700, slug: 'duplo' },
      ]);
      const { service } = makeService(prisma);
      mockFetch();

      await service.run();

      expect(prisma.legoTheme.update).toHaveBeenCalledWith({
        where: { id: 498 },
        data: { slug: '#498' },
      });
      expect(prisma.legoTheme.update).toHaveBeenCalledWith({
        where: { id: 700 },
        data: { slug: 'duplo-700' },
      });
      expect(prisma.legoTheme.update).toHaveBeenCalledTimes(2);
      // Liberation d'abord, insertion ensuite : sinon l'ODKU toucherait la mauvaise ligne.
      const themeInsert = prisma.$executeRaw.mock.calls.findIndex(
        ([strings]: [TemplateStringsArray]) =>
          strings.join('').includes('INSERT INTO lego_themes'),
      );
      const lastRelease = Math.max(
        ...prisma.legoTheme.update.mock.invocationCallOrder,
      );
      expect(lastRelease).toBeLessThan(
        prisma.$executeRaw.mock.invocationCallOrder[themeInsert],
      );
    });

    it('le slug d un theme retire est cherche jusqu a un slug libre', async () => {
      const prisma = makePrisma();
      prisma.legoTheme.findMany.mockResolvedValue([
        { id: 700, slug: 'duplo' },
        // Retire lui aussi, et deja sur le premier candidat.
        { id: 701, slug: 'duplo-700' },
      ]);
      const { service } = makeService(prisma);
      mockFetch();

      const report = await service.run();

      expect(report.state).toBe('done');
      expect(prisma.legoTheme.update).toHaveBeenCalledWith({
        where: { id: 700 },
        data: { slug: 'duplo-700-2' },
      });
      expect(prisma.legoTheme.update).toHaveBeenCalledTimes(1);
    });

    it('marque retires les themes absents du CSV, et remet a NULL ceux qui reviennent', async () => {
      const prisma = makePrisma();
      const { service } = makeService(prisma);
      mockFetch();

      await service.run();

      expect(prisma.legoTheme.updateMany).toHaveBeenCalledWith({
        where: { id: { notIn: [1, 3, 497, 498, 632] }, retiredAt: null },
        data: { retiredAt: expect.any(Date) },
      });
      const [write] = rawWrites(prisma, 'lego_themes');
      expect(write.sql).toMatch(/retired_at\s*=\s*NULL/);
    });

    it('compte les figurines sur l inventaire de plus petite version', async () => {
      const prisma = makePrisma();
      const { service } = makeService(prisma);
      mockFetch();

      await service.run();

      const sets = bySetNum(prisma);
      // Version 1 sans figurine : 0, et non les 3 de la version 4.
      expect(sets.get('42131-1')!.minifigs).toBe(0);
      // Version 1 listee apres la version 2 : 1 figurine, pas 2.
      expect(sets.get('4434-1')!.minifigs).toBe(1);
      // Inventaire sans aucune ligne de figurine : 0.
      expect(sets.get('10952-1')!.minifigs).toBe(0);
      // Aucun inventaire : inconnu, pas zero.
      expect(sets.get('9999-1')!.minifigs).toBeNull();
    });

    it('ecrit chaque set colonne par colonne, nom entre guillemets sans les guillemets', async () => {
      const prisma = makePrisma();
      const { service } = makeService(prisma);
      mockFetch();

      await service.run();

      const sets = bySetNum(prisma);
      expect(sets.get('10952-1')).toEqual({
        set_num: '10952-1',
        name: 'Barn, Tractor & Farm Animal Care',
        year: 2021,
        theme_id: 632,
        num_parts: 97,
        minifigs: 0,
        image_url: 'https://cdn.rebrickable.com/media/sets/10952-1.jpg',
        updated_at: { literal: 'CURRENT_TIMESTAMP(3)' },
      });
      expect(sets.get('4434-1')!.image_url).toBeNull();
    });

    it('n ecrit jamais ean, upc ni brickset_id', async () => {
      const prisma = makePrisma();
      const { service } = makeService(prisma);
      mockFetch();

      await service.run();

      const [write] = rawWrites(prisma, 'lego_sets');
      expect(write.sql).not.toMatch(/\b(ean|upc|brickset_id)\b/);
      expect(write.sql).toContain('ON DUPLICATE KEY UPDATE');
    });
  });

  describe('import inchange', () => {
    it('ne telecharge rien quand Last-Modified est celui du dernier done', async () => {
      const prisma = makePrisma();
      prisma.importRun.findFirst.mockResolvedValue({
        id: 'run-0',
        state: 'done',
        watermark: new Date(LAST_MODIFIED),
      });
      const { service } = makeService(prisma);
      const fetchSpy = mockFetch();

      const report = await service.run();

      expect(report.state).toBe('unchanged');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][1]).toMatchObject({ method: 'HEAD' });
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
      expect(prisma.importRun.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { source: 'rebrickable', state: 'done' },
        }),
      );
      expect(prisma.importRun.runs.at(-1)!.state).toBe('unchanged');
    });

    it('force=true passe outre', async () => {
      const prisma = makePrisma();
      prisma.importRun.findFirst.mockResolvedValue({
        id: 'run-0',
        state: 'done',
        watermark: new Date(LAST_MODIFIED),
      });
      const { service } = makeService(prisma);
      mockFetch();

      const report = await service.run({ force: true });

      expect(report).toMatchObject({
        state: 'done',
        mode: 'forced',
        rowsUpserted: 4,
      });
    });

    it('importe quand Last-Modified differe', async () => {
      const prisma = makePrisma();
      prisma.importRun.findFirst.mockResolvedValue({
        id: 'run-0',
        state: 'done',
        watermark: new Date('2026-10-01T00:00:00Z'),
      });
      const { service } = makeService(prisma);
      mockFetch();

      expect((await service.run()).state).toBe('done');
    });

    it('HEAD refuse (405) : import sans controle conditionnel, pas d echec', async () => {
      const prisma = makePrisma();
      prisma.importRun.findFirst.mockResolvedValue({
        id: 'run-0',
        state: 'done',
        watermark: new Date(LAST_MODIFIED),
      });
      const { service } = makeService(prisma);
      const fetchSpy = mockFetch((_file, method) =>
        method === 'HEAD' ? new Response(null, { status: 405 }) : undefined,
      );

      const report = await service.run();

      expect(report).toMatchObject({
        state: 'done',
        rowsUpserted: 4,
        // Le filigrane vient du GET de sets.csv.gz.
        lastModified: new Date(LAST_MODIFIED).toISOString(),
      });
      expect(
        fetchSpy.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('sets.csv.gz') && init?.method === 'GET',
        ),
      ).toBe(true);
    });
  });

  describe('CSV en echec', () => {
    it('HTTP != 200 : run failed avec lastError, les lignes deja ecrites restent', async () => {
      const prisma = makePrisma();
      const { service } = makeService(prisma);
      mockFetch((file) =>
        file === 'inventories.csv.gz'
          ? new Response('maintenance', { status: 503 })
          : undefined,
      );

      const report = await service.run();

      expect(report.state).toBe('failed');
      expect(report.lastError).toContain('HTTP 503');
      // Les themes, ecrits avant l'echec, ne sont pas annules.
      expect(rawWrites(prisma, 'lego_themes')).toHaveLength(1);
      expect(prisma.importRun.runs.at(-1)).toMatchObject({
        state: 'failed',
        lastError: expect.stringContaining('HTTP 503'),
      });
    });

    it('gzip invalide : run failed', async () => {
      const prisma = makePrisma();
      const { service } = makeService(prisma);
      mockFetch((file, method) =>
        file === 'themes.csv.gz' && method === 'GET'
          ? new Response('<html>pas du gzip</html>', { status: 200 })
          : undefined,
      );

      const report = await service.run();

      expect(report.state).toBe('failed');
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('CSV dont les colonnes ont change : run failed', async () => {
      const prisma = makePrisma();
      const { service } = makeService(prisma);
      mockFetch((file, method) =>
        file === 'sets.csv.gz' && method === 'GET'
          ? new Response(gz('num,title\n42131-1,Cat\n'), { status: 200 })
          : undefined,
      );

      const report = await service.run();

      expect(report.state).toBe('failed');
      expect(report.lastError).toContain('set_num');
    });

    it('inventories valide mais vide : run failed, aucune figurine passee a NULL', async () => {
      const prisma = makePrisma();
      const { service } = makeService(prisma);
      mockFetch((file, method) =>
        file === 'inventories.csv.gz' && method === 'GET'
          ? new Response(gz('id,version,set_num\n'), { status: 200 })
          : undefined,
      );

      const report = await service.run();

      expect(report.state).toBe('failed');
      expect(report.lastError).toContain('aucun inventaire');
      expect(rawWrites(prisma, 'lego_sets')).toHaveLength(0);
    });

    it('sets valide mais vide : run failed', async () => {
      const prisma = makePrisma();
      const { service } = makeService(prisma);
      mockFetch((file, method) =>
        file === 'sets.csv.gz' && method === 'GET'
          ? new Response(gz('set_num,name,year,theme_id,num_parts,img_url\n'), {
              status: 200,
            })
          : undefined,
      );

      const report = await service.run();

      expect(report.state).toBe('failed');
      expect(report.lastError).toContain('aucun set');
    });

    it('themes valide mais vide : run failed', async () => {
      const prisma = makePrisma();
      const { service } = makeService(prisma);
      mockFetch((file, method) =>
        file === 'themes.csv.gz' && method === 'GET'
          ? new Response(gz('id,name,parent_id\n'), { status: 200 })
          : undefined,
      );

      const report = await service.run();

      expect(report.state).toBe('failed');
      expect(report.lastError).toContain('aucun theme');
    });

    it('un run orphelin (processus arrete en plein import) est clos en failed', async () => {
      const prisma = makePrisma([
        { id: 'orphan', source: 'rebrickable', state: 'running' },
        // Une campagne Brickset en cours n'est pas l'affaire de l'import.
        { id: 'harvest', source: 'brickset', state: 'running' },
      ]);
      const { service } = makeService(prisma);
      mockFetch();

      const report = await service.run();

      const [orphan, harvest, current] = prisma.importRun.runs;
      expect(orphan).toMatchObject({
        state: 'failed',
        lastError: expect.stringContaining('interrompu'),
        finishedAt: expect.any(Date),
      });
      expect(harvest.state).toBe('running');
      expect(current).toMatchObject({ id: report.runId, state: 'done' });
    });
  });

  it('single-flight : deux demandes simultanees partagent le meme import', async () => {
    const prisma = makePrisma();
    const { service } = makeService(prisma);
    mockFetch();

    const [a, b] = await Promise.all([service.run(), service.run()]);

    expect(a).toBe(b);
    expect(prisma.importRun.create).toHaveBeenCalledTimes(1);
  });
});
