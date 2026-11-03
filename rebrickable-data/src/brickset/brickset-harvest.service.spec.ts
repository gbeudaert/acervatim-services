import { PrismaService } from '../prisma/prisma.service';
import {
  bricksetPatch,
  BricksetHarvestService,
  bricksetSetNum,
  plausibleCode,
} from './brickset-harvest.service';
import {
  BricksetBudgetExhaustedError,
  BricksetService,
} from './brickset.service';
import { BricksetGetSetsResponse, BricksetSet } from './brickset.types';

function bricksetSet(overrides: Partial<BricksetSet> = {}): BricksetSet {
  return {
    setID: 31000,
    number: '42131',
    numberVariant: 1,
    name: 'App-Controlled Cat D11 Bulldozer',
    year: 2021,
    theme: 'Technic',
    themeGroup: 'Technical',
    subtheme: null,
    pieces: 3854,
    minifigs: 0,
    barcode: { EAN: '5702016616331', UPC: '673419340496' },
    ...overrides,
  };
}

describe('bricksetSetNum', () => {
  it('recompose le numero canonique Rebrickable', () => {
    expect(bricksetSetNum(bricksetSet())).toBe('42131-1');
  });

  it('conserve une variante superieure a 1', () => {
    expect(bricksetSetNum(bricksetSet({ numberVariant: 2 }))).toBe('42131-2');
  });

  it('retombe sur la variante 1 quand Brickset ne la renseigne pas', () => {
    // Brickset rend 0 (ou rien) sur certaines fiches ; Rebrickable, lui, suffixe
    // toujours. Sans ce repli, la jointure raterait toute la ligne.
    expect(bricksetSetNum(bricksetSet({ numberVariant: 0 }))).toBe('42131-1');
  });

  it('refuse une fiche sans numero plutot que de fabriquer une cle', () => {
    expect(bricksetSetNum(bricksetSet({ number: '' }))).toBeNull();
  });
});

describe('bricksetPatch', () => {
  const empty = { ean: null, upc: null, bricksetId: null };

  it('n ecrit que ean, upc et bricksetId, normalises', () => {
    expect(
      bricksetPatch(
        bricksetSet({ barcode: { EAN: '5 702016 616331', UPC: null } }),
        empty,
      ),
    ).toEqual({ ean: '5702016616331', bricksetId: 31000 });
  });

  it('n efface jamais un code connu par une valeur vide', () => {
    const patch = bricksetPatch(
      bricksetSet({ barcode: { EAN: '', UPC: '673419340496' } }),
      { ean: '5702016616331', upc: null, bricksetId: 31000 },
    );
    expect(patch).toEqual({ upc: '673419340496' });
    expect(patch).not.toHaveProperty('ean');
  });

  it('ignore une fiche sans aucun code, y compris son bricksetId', () => {
    expect(
      bricksetPatch(bricksetSet({ barcode: { EAN: '', UPC: null } }), empty),
    ).toBeNull();
    expect(
      bricksetPatch(bricksetSet({ barcode: undefined }), empty),
    ).toBeNull();
  });

  it('ignore un code implausible', () => {
    expect(
      bricksetPatch(bricksetSet({ barcode: { EAN: '0', UPC: 'N/A' } }), empty),
    ).toBeNull();
  });

  it('n ecrit rien quand tout est deja connu', () => {
    expect(
      bricksetPatch(bricksetSet(), {
        ean: '5702016616331',
        upc: '673419340496',
        bricksetId: 31000,
      }),
    ).toBeNull();
  });
});

describe('plausibleCode', () => {
  it('ramene un GTIN-14 a zero de tete a son EAN-13, la forme qu un scan retrouve', () => {
    expect(plausibleCode('05702016616331')).toBe('5702016616331');
    expect(plausibleCode('0 5702016 616331')).toBe('5702016616331');
  });

  it('garde un GTIN-14 sans zero de tete tel quel', () => {
    expect(plausibleCode('15702016616338')).toBe('15702016616338');
  });

  it('rejette les codes trop courts ou trop longs', () => {
    expect(plausibleCode('1234567')).toBeNull();
    expect(plausibleCode('123456789012345')).toBeNull();
  });
});

type Run = {
  id: string;
  source: string;
  mode: string;
  state: string;
  startedAt: Date;
  lastPage: number;
  watermark: Date | null;
};

function makeHarvest(opts: {
  lastDone?: Run | null;
  open?: Run | null;
  known?: Array<{
    setNum: string;
    ean: string | null;
    upc: string | null;
    bricksetId: number | null;
  }>;
  pages?: Array<BricksetGetSetsResponse | Error>;
  configured?: boolean;
}) {
  const prisma = {
    importRun: {
      findFirst: jest.fn(async ({ where }: { where: { state: unknown } }) =>
        where.state === 'done' ? (opts.lastDone ?? null) : (opts.open ?? null),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'run-new',
        startedAt: new Date(),
        ...data,
      })),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    // Volontairement ni `create` ni `upsert` : le moissonnage ne cree jamais de set.
    legoSet: {
      findMany: jest.fn().mockResolvedValue(opts.known ?? []),
      update: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const getSets = jest.fn();
  for (const page of opts.pages ?? []) {
    if (page instanceof Error) getSets.mockRejectedValueOnce(page);
    else getSets.mockResolvedValueOnce(page);
  }
  const brickset = {
    isConfigured: () => opts.configured ?? true,
    getSets,
  };
  const service = new BricksetHarvestService(
    prisma as unknown as PrismaService,
    brickset as unknown as BricksetService,
  );
  return { service, prisma, getSets };
}

/** Etat connu de 42131-1 : une copie neuve a chaque appel (`applyPage` met son instantane a jour). */
function known42131(overrides: Partial<{ ean: string; upc: string }> = {}) {
  return {
    setNum: '42131-1',
    ean: null as string | null,
    upc: null as string | null,
    bricksetId: null as number | null,
    ...overrides,
  };
}

describe('BricksetHarvestService', () => {
  it('met a jour les sets connus seulement, et compte les autres dans unmatched', async () => {
    const { service, prisma } = makeHarvest({
      known: [known42131()],
      pages: [
        {
          status: 'success',
          matches: 3,
          sets: [
            bricksetSet(),
            bricksetSet({ setID: 2, number: '99999' }),
            bricksetSet({ setID: 3, number: '' }),
          ],
        },
      ],
    });

    const report = await service.run();

    expect(report).toMatchObject({
      state: 'done',
      rowsUpserted: 1,
      unmatched: 2,
      callsUsed: 1,
    });
    expect(prisma.legoSet.update).toHaveBeenCalledTimes(1);
    expect(prisma.legoSet.update).toHaveBeenCalledWith({
      where: { setNum: '42131-1' },
      data: { ean: '5702016616331', upc: '673419340496', bricksetId: 31000 },
    });
    expect(prisma.importRun.update).toHaveBeenLastCalledWith({
      where: { id: 'run-new' },
      data: expect.objectContaining({ state: 'done' }),
    });
  });

  it('ignore les codes vides', async () => {
    const { service, prisma } = makeHarvest({
      known: [known42131({ ean: '5702016616331' })],
      pages: [
        {
          status: 'success',
          matches: 1,
          sets: [bricksetSet({ barcode: { EAN: '', UPC: '' } })],
        },
      ],
    });

    const report = await service.run();

    expect(report).toMatchObject({
      state: 'done',
      rowsUpserted: 0,
      unmatched: 0,
    });
    expect(prisma.legoSet.update).not.toHaveBeenCalled();
  });

  it('premiere campagne : mode full, sans updatedSince', async () => {
    const { service, getSets, prisma } = makeHarvest({
      pages: [{ status: 'success', matches: 0, sets: [] }],
    });

    await service.run();

    expect(getSets).toHaveBeenCalledWith(
      expect.objectContaining({ pageNumber: 1, pageSize: 500 }),
    );
    expect(getSets.mock.calls[0][0].updatedSince).toBeUndefined();
    expect(prisma.importRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ mode: 'full', lastPage: 0 }),
    });
  });

  it('prend le filigrane sur le dernier done, quel que soit son mode', async () => {
    const lastDone: Run = {
      id: 'run-done',
      source: 'brickset',
      mode: 'incremental',
      state: 'done',
      startedAt: new Date('2026-10-30T03:30:00Z'),
      lastPage: 1,
      watermark: new Date('2026-10-30T03:30:00Z'),
    };
    const { service, getSets, prisma } = makeHarvest({
      lastDone,
      pages: [{ status: 'success', matches: 0, sets: [] }],
    });

    const report = await service.run();

    expect(report.mode).toBe('incremental');
    expect(prisma.importRun.findFirst).toHaveBeenCalledWith({
      where: { source: 'brickset', state: 'done' },
      orderBy: { finishedAt: 'desc' },
    });
    expect(getSets).toHaveBeenCalledWith(
      expect.objectContaining({ updatedSince: '2026-10-30', pageNumber: 1 }),
    );
  });

  it('reprend une campagne en relisant la derniere page lue et passe l ancien run a superseded', async () => {
    const watermark = new Date('2026-11-01T03:30:00Z');
    const open: Run = {
      id: 'run-paused',
      source: 'brickset',
      mode: 'full',
      state: 'paused',
      startedAt: new Date('2026-11-01T03:30:00Z'),
      lastPage: 3,
      watermark,
    };
    const { service, getSets, prisma } = makeHarvest({
      open,
      pages: [{ status: 'success', matches: 1600, sets: [] }],
    });

    const report = await service.run();

    expect(prisma.importRun.updateMany).toHaveBeenCalledWith({
      where: {
        source: 'brickset',
        state: { in: ['running', 'paused', 'failed'] },
      },
      data: expect.objectContaining({ state: 'superseded' }),
    });
    // Meme campagne : meme mode, meme borne haute, position conservee.
    expect(prisma.importRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ mode: 'full', lastPage: 3, watermark }),
    });
    // Recouvrement d'une page : la page 3, deja consommee, est relue avant la 4.
    expect(getSets.mock.calls.map(([p]) => p.pageNumber)).toEqual([3]);
    expect(report).toMatchObject({ fromPage: 3, lastPage: 3, state: 'done' });
  });

  it('ignore un run ouvert anterieur au dernier done', async () => {
    const { service, getSets, prisma } = makeHarvest({
      lastDone: {
        id: 'run-done',
        source: 'brickset',
        mode: 'full',
        state: 'done',
        startedAt: new Date('2026-10-30T03:30:00Z'),
        lastPage: 40,
        watermark: new Date('2026-10-30T03:30:00Z'),
      },
      open: {
        id: 'run-old',
        source: 'brickset',
        mode: 'full',
        state: 'failed',
        startedAt: new Date('2026-10-01T03:30:00Z'),
        lastPage: 12,
        watermark: null,
      },
      pages: [{ status: 'success', matches: 0, sets: [] }],
    });

    await service.run();

    expect(getSets).toHaveBeenCalledWith(
      expect.objectContaining({ pageNumber: 1, updatedSince: '2026-10-30' }),
    );
    expect(prisma.importRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ mode: 'incremental', lastPage: 0 }),
    });
  });

  it('budget epuise : run paused, position conservee pour la reprise', async () => {
    const fullPage = Array.from({ length: 500 }, (_, i) =>
      bricksetSet({ setID: i + 1, number: `${10000 + i}` }),
    );
    const { service, prisma } = makeHarvest({
      pages: [
        { status: 'success', matches: 5000, sets: fullPage },
        new BricksetBudgetExhaustedError(90, 90),
      ],
    });

    const report = await service.run();

    expect(report).toMatchObject({
      state: 'paused',
      stoppedBy: 'daily-budget',
      lastPage: 1,
      callsUsed: 1,
      unmatched: 500,
    });
    expect(prisma.importRun.update).toHaveBeenCalledWith({
      where: { id: 'run-new' },
      data: expect.objectContaining({ lastPage: 1 }),
    });
    expect(prisma.importRun.update).toHaveBeenLastCalledWith({
      where: { id: 'run-new' },
      data: expect.objectContaining({ state: 'paused' }),
    });
  });

  it('erreur amont : run failed, reprenable', async () => {
    const { service, prisma } = makeHarvest({
      pages: [new Error('brickset: upstream unavailable')],
    });

    const report = await service.run();

    expect(report.state).toBe('failed');
    expect(prisma.importRun.update).toHaveBeenLastCalledWith({
      where: { id: 'run-new' },
      data: expect.objectContaining({
        state: 'failed',
        lastError: 'brickset: upstream unavailable',
      }),
    });
  });

  it('sans cle : aucun run, aucun appel', async () => {
    const { service, prisma, getSets } = makeHarvest({ configured: false });

    const report = await service.run();

    expect(report).toMatchObject({
      state: 'skipped',
      stoppedBy: 'not-configured',
    });
    expect(prisma.importRun.create).not.toHaveBeenCalled();
    expect(getSets).not.toHaveBeenCalled();
  });
  it('la reprise relit la page de bordure puis continue', async () => {
    const fullPage = Array.from({ length: 500 }, (_, i) =>
      bricksetSet({ setID: i + 1, number: `${20000 + i}` }),
    );
    const { service, getSets } = makeHarvest({
      open: {
        id: 'run-paused',
        source: 'brickset',
        mode: 'full',
        state: 'paused',
        startedAt: new Date('2026-11-01T03:30:00Z'),
        lastPage: 7,
        watermark: new Date('2026-11-01T03:30:00Z'),
      },
      pages: [
        { status: 'success', matches: 4200, sets: fullPage },
        { status: 'success', matches: 4200, sets: [] },
      ],
    });

    const report = await service.run();

    expect(getSets.mock.calls.map(([p]) => p.pageNumber)).toEqual([7, 8]);
    expect(report).toMatchObject({ fromPage: 7, lastPage: 8, state: 'done' });
  });

  it('un meme setNum deux fois dans une page : ecrit une fois, compte une fois', async () => {
    const { service, prisma } = makeHarvest({
      known: [known42131()],
      pages: [
        {
          status: 'success',
          matches: 2,
          // Variante 0 ramenee a 1 : deux fiches pour "42131-1".
          sets: [bricksetSet({ numberVariant: 0 }), bricksetSet()],
        },
      ],
    });

    const report = await service.run();

    expect(prisma.legoSet.update).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ rowsUpserted: 1, unmatched: 0 });
  });

  it('deux fiches differentes pour un meme set : la seconde est comparee a la premiere ecriture', async () => {
    const { service, prisma } = makeHarvest({
      known: [known42131()],
      pages: [
        {
          status: 'success',
          matches: 2,
          sets: [
            bricksetSet({
              numberVariant: 0,
              barcode: { EAN: '5702016616331', UPC: null },
            }),
            bricksetSet({
              barcode: { EAN: '5702016616331', UPC: '673419340496' },
            }),
          ],
        },
      ],
    });

    const report = await service.run();

    // La seconde n'apporte que l'UPC : l'EAN vient d'etre ecrit.
    expect(prisma.legoSet.update).toHaveBeenNthCalledWith(2, {
      where: { setNum: '42131-1' },
      data: { upc: '673419340496' },
    });
    expect(report.rowsUpserted).toBe(1);
  });

  it('rapproche sans tenir compte de la casse (COMCON001 / comcon001-1)', async () => {
    const { service, prisma } = makeHarvest({
      known: [
        { setNum: 'comcon001-1', ean: null, upc: null, bricksetId: null },
      ],
      pages: [
        {
          status: 'success',
          matches: 1,
          sets: [bricksetSet({ number: 'COMCON001', numberVariant: 1 })],
        },
      ],
    });

    const report = await service.run();

    expect(report).toMatchObject({ rowsUpserted: 1, unmatched: 0 });
    expect(prisma.legoSet.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { setNum: 'comcon001-1' } }),
    );
  });
});
