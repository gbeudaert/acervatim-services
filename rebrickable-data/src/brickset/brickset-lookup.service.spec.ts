import {
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CatalogService } from '../catalog/catalog.service';
import { ApiCacheService } from '../common/cache/api-cache.service';
import { InternalLegoSet } from '../common/internal/contracts';
import { PrismaService } from '../prisma/prisma.service';
import {
  BricksetLookupService,
  canonicalCode,
  missKey,
} from './brickset-lookup.service';
import {
  BricksetBudgetExhaustedError,
  BricksetService,
} from './brickset.service';
import { BricksetGetSetsResponse, BricksetSet } from './brickset.types';

const EAN = '5702015869935';
const UPC = '673419267656';
const NOW = new Date('2026-11-17T10:00:00Z');

function bricksetSet(overrides: Partial<BricksetSet> = {}): BricksetSet {
  return {
    setID: 26725,
    number: '75192',
    numberVariant: 1,
    name: 'Millennium Falcon',
    year: 2017,
    theme: 'Star Wars',
    themeGroup: 'Licensed',
    subtheme: 'Ultimate Collector Series',
    pieces: 7541,
    minifigs: 8,
    barcode: { EAN, UPC },
    ...overrides,
  };
}

const FALCON = { setNum: '75192-1' } as InternalLegoSet;

/** Laisse passer toutes les promesses en attente (setImmediate n'est pas simule). */
const flush = () => new Promise((r) => setImmediate(r));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function makeLookup(opts: {
  /** Lectures successives de `findByBarcode` (avant puis apres l'appel). */
  local?: InternalLegoSet[][];
  miss?: boolean;
  configured?: boolean;
  remote?: BricksetGetSetsResponse | Error | Promise<BricksetGetSetsResponse>;
  known?: Array<{
    setNum: string;
    ean: string | null;
    upc: string | null;
    bricksetId: number | null;
  }>;
  waitMs?: number;
}) {
  const findByBarcode = jest.fn();
  for (const rows of opts.local ?? [[]]) findByBarcode.mockResolvedValueOnce(rows);
  findByBarcode.mockResolvedValue([]);
  const catalog = { findByBarcode };
  const cache = {
    get: jest.fn().mockResolvedValue(opts.miss ? { checkedAt: 'x' } : null),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const getSets = jest.fn();
  const remote = opts.remote ?? { status: 'success', matches: 0, sets: [] };
  if (remote instanceof Error) getSets.mockRejectedValue(remote);
  else getSets.mockImplementation(() => Promise.resolve(remote));
  const brickset = {
    isConfigured: () => opts.configured ?? true,
    getSets,
  };
  const prisma = {
    // Volontairement ni `create` ni `upsert` : une reponse Brickset ne cree jamais de set.
    legoSet: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          opts.known ?? [
            { setNum: '75192-1', ean: null, upc: null, bricksetId: null },
          ],
        ),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const values: Record<string, unknown> = {
    BRICKSET_BARCODE_TTL_DAYS: 90,
    BRICKSET_MISS_TTL_DAYS: 7,
    BRICKSET_SCAN_WAIT_MS: opts.waitMs ?? 1000,
  };
  const config = {
    get: (key: string, fallback?: unknown) => values[key] ?? fallback,
  } as unknown as ConfigService;
  const service = new BricksetLookupService(
    prisma as unknown as PrismaService,
    catalog as unknown as CatalogService,
    brickset as unknown as BricksetService,
    cache as unknown as ApiCacheService,
    config,
  );
  service.onModuleInit();
  return { service, catalog, cache, getSets, prisma };
}

describe('BricksetLookupService', () => {
  beforeEach(() => {
    jest.useFakeTimers({
      now: NOW,
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
  });
  afterEach(() => jest.useRealTimers());

  it('code en cache : servi sans appel, fraicheur de 90 jours', async () => {
    const { service, catalog, getSets } = makeLookup({ local: [[FALCON]] });

    expect(await service.lookup(EAN)).toEqual({
      items: [FALCON],
      lookup: 'cache',
    });
    expect(getSets).not.toHaveBeenCalled();
    expect(catalog.findByBarcode).toHaveBeenCalledWith(
      EAN,
      new Date('2026-08-19T10:00:00Z'),
    );
  });

  it('code inconnu : un appel, le set des CSV est annote puis relu', async () => {
    const { service, getSets, prisma } = makeLookup({
      local: [[], [FALCON]],
      remote: { status: 'success', matches: 1, sets: [bricksetSet()] },
    });

    expect(await service.lookup(EAN)).toEqual({
      items: [FALCON],
      lookup: 'brickset',
    });
    expect(getSets).toHaveBeenCalledTimes(1);
    expect(getSets).toHaveBeenCalledWith({
      query: EAN,
      pageNumber: 1,
      pageSize: 20,
    });
    expect(prisma.legoSet.update).toHaveBeenCalledWith({
      where: { setNum: '75192-1' },
      data: { ean: EAN, upc: UPC, bricksetId: 26725, barcodeCheckedAt: NOW },
    });
  });

  it('codes inchanges : la date avance quand meme, c est elle qui fait courir les 90 jours', async () => {
    const { service, prisma } = makeLookup({
      local: [[], [FALCON]],
      known: [{ setNum: '75192-1', ean: EAN, upc: UPC, bricksetId: 26725 }],
      remote: { status: 'success', sets: [bricksetSet()] },
    });

    await service.lookup(EAN);

    expect(prisma.legoSet.update).toHaveBeenCalledWith({
      where: { setNum: '75192-1' },
      data: { barcodeCheckedAt: NOW },
    });
  });

  it('cherche un UPC scanne en EAN-13 sous ses 12 chiffres, la forme publiee par Brickset', async () => {
    const { service, getSets } = makeLookup({
      local: [[], [FALCON]],
      remote: { status: 'success', sets: [bricksetSet()] },
    });

    expect((await service.lookup(`0${UPC}`)).lookup).toBe('brickset');
    expect(getSets).toHaveBeenCalledWith(
      expect.objectContaining({ query: UPC }),
    );
  });

  it('ecarte les fiches qui ne portent pas le code, et ne cree aucun set', async () => {
    const { service, prisma, cache } = makeLookup({
      remote: {
        status: 'success',
        sets: [
          bricksetSet({
            number: '10179',
            barcode: { EAN: '5702014432239', UPC: null },
          }),
        ],
      },
    });

    expect(await service.lookup(EAN)).toEqual({ items: [], lookup: 'miss' });
    expect(prisma.legoSet.update).not.toHaveBeenCalled();
    expect(cache.set).toHaveBeenCalledWith(
      missKey(EAN),
      expect.any(Object),
      7 * 24 * 3600,
    );
  });

  it('set connu de Brickset mais absent des CSV : miss, rien d ecrit', async () => {
    const { service, prisma } = makeLookup({
      known: [],
      remote: { status: 'success', sets: [bricksetSet()] },
    });

    expect((await service.lookup(EAN)).lookup).toBe('miss');
    expect(prisma.legoSet.update).not.toHaveBeenCalled();
  });

  it('code marque inconnu : liste vide, aucun appel', async () => {
    const { service, getSets, cache } = makeLookup({ miss: true });

    expect(await service.lookup(EAN)).toEqual({ items: [], lookup: 'miss' });
    expect(cache.get).toHaveBeenCalledWith(`brickset:miss:${EAN}`);
    expect(getSets).not.toHaveBeenCalled();
  });

  it('sans cle : disabled, aucun appel', async () => {
    const { service, getSets } = makeLookup({ configured: false });

    expect(await service.lookup(EAN)).toEqual({
      items: [],
      lookup: 'disabled',
    });
    expect(getSets).not.toHaveBeenCalled();
  });

  it('budget epuise : exhausted, et le code n est pas marque inconnu', async () => {
    const { service, cache } = makeLookup({
      remote: new BricksetBudgetExhaustedError(90, 90),
    });

    expect((await service.lookup(EAN)).lookup).toBe('exhausted');
    expect(cache.set).not.toHaveBeenCalled();
  });

  it.each([
    ['Brickset en erreur', new BadGatewayException('brickset: upstream')],
    ['file indisponible', new ServiceUnavailableException('redis')],
  ])(
    '%s : unavailable, et le code n est pas marque inconnu',
    async (_label, err) => {
      const { service, cache } = makeLookup({ remote: err });

      expect((await service.lookup(EAN)).lookup).toBe('unavailable');
      expect(cache.set).not.toHaveBeenCalled();
    },
  );

  it('deux scans simultanes du meme code : un seul appel', async () => {
    const gate = deferred<BricksetGetSetsResponse>();
    const { service, getSets } = makeLookup({
      local: [[], [], [FALCON], [FALCON]],
      remote: gate.promise,
    });

    const first = service.lookup(EAN);
    const second = service.lookup(EAN);
    await flush();
    gate.resolve({ status: 'success', sets: [bricksetSet()] });

    expect((await first).lookup).toBe('brickset');
    expect((await second).lookup).toBe('brickset');
    expect(getSets).toHaveBeenCalledTimes(1);
  });

  it('Brickset trop lent : pending, puis l appel termine remplit le cache', async () => {
    const gate = deferred<BricksetGetSetsResponse>();
    const { service, prisma } = makeLookup({
      remote: gate.promise,
      waitMs: 1000,
    });

    const scan = service.lookup(EAN);
    await flush();
    await jest.advanceTimersByTimeAsync(1000);
    expect(await scan).toEqual({ items: [], lookup: 'pending' });

    gate.resolve({ status: 'success', sets: [bricksetSet()] });
    await flush();
    expect(prisma.legoSet.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { setNum: '75192-1' } }),
    );
  });

  it('canonicalCode : la plus courte des variantes', () => {
    expect(canonicalCode([`0${UPC}`, UPC])).toBe(UPC);
    expect(canonicalCode([UPC, `0${UPC}`])).toBe(UPC);
    expect(canonicalCode([EAN])).toBe(EAN);
  });
});
