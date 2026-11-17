import { ConfigService } from '@nestjs/config';
import { BricksetLookupService } from '../brickset/brickset-lookup.service';
import { CatalogService } from '../catalog/catalog.service';
import { ApiCacheService } from '../common/cache/api-cache.service';
import { RebrickableCsvService } from '../import/rebrickable-csv.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  DAILY_REFRESH_CRON,
  DailyRefreshService,
} from './daily-refresh.service';

const FRESH_SINCE = new Date('2026-08-19T03:00:00Z');

function importResult(state: string) {
  return jest.fn().mockResolvedValue({ state, rowsUpserted: 0, themes: 0 });
}

function makeJobs(opts: {
  sets?: number;
  nodeEnv?: string;
  importer?: jest.Mock;
}) {
  const prisma = {
    legoSet: { count: jest.fn().mockResolvedValue(opts.sets ?? 0) },
  };
  const importer = { run: opts.importer ?? importResult('done') };
  const catalog = { purgeExpiredBarcodes: jest.fn().mockResolvedValue(3) };
  const barcodes = { freshSince: jest.fn().mockReturnValue(FRESH_SINCE) };
  const cache = { pruneExpired: jest.fn().mockResolvedValue(0) };
  const config = {
    get: () => opts.nodeEnv ?? 'development',
  } as unknown as ConfigService;
  const service = new DailyRefreshService(
    prisma as unknown as PrismaService,
    importer as unknown as RebrickableCsvService,
    catalog as unknown as CatalogService,
    barcodes as unknown as BricksetLookupService,
    cache as unknown as ApiCacheService,
    config,
  );
  return { service, prisma, importer, catalog, cache };
}

describe('DailyRefreshService', () => {
  it('un seul cron, 03:00 UTC', () => {
    expect(DAILY_REFRESH_CRON).toBe('0 0 3 * * *');
    expect(
      Reflect.getMetadata(
        'SCHEDULE_CRON_OPTIONS',
        DailyRefreshService.prototype.daily,
      ),
    ).toMatchObject({ cronTime: DAILY_REFRESH_CRON, timeZone: 'UTC' });
  });

  it('enchaine import, purge du cache puis effacement des codes expires', async () => {
    const { service, importer, catalog, cache } = makeJobs({});

    await service.daily();

    expect(importer.run.mock.invocationCallOrder[0]).toBeLessThan(
      cache.pruneExpired.mock.invocationCallOrder[0],
    );
    expect(cache.pruneExpired.mock.invocationCallOrder[0]).toBeLessThan(
      catalog.purgeExpiredBarcodes.mock.invocationCallOrder[0],
    );
    expect(catalog.purgeExpiredBarcodes).toHaveBeenCalledWith(FRESH_SINCE);
  });

  it('ne contient plus aucune campagne Brickset', () => {
    const { service } = makeJobs({});
    expect(service).not.toHaveProperty('harvest');
  });

  it.each([
    ['unchanged', importResult('unchanged')],
    ['failed', importResult('failed')],
    [
      'en exception',
      jest.fn().mockRejectedValue(new Error('base injoignable')),
    ],
  ])(
    'efface les codes expires meme si l import est %s',
    async (_label, importer) => {
      const { service, catalog } = makeJobs({ importer });

      const report = await service.refresh('test');

      expect(catalog.purgeExpiredBarcodes).toHaveBeenCalledTimes(1);
      expect(report.expiredBarcodes).toBe(3);
    },
  );

  it('un echec de l effacement ne fait pas echouer le passage', async () => {
    const { service, catalog } = makeJobs({});
    catalog.purgeExpiredBarcodes.mockRejectedValueOnce(new Error('verrou'));

    const report = await service.refresh('test');

    expect(report).toMatchObject({ expiredBarcodes: null });
    expect(report.import).toMatchObject({ state: 'done' });
  });

  it('au demarrage, catalogue vide : import en tache de fond', async () => {
    const { service, importer } = makeJobs({ sets: 0 });

    service.onApplicationBootstrap();
    await service.bootRefresh;

    expect(importer.run).toHaveBeenCalledTimes(1);
  });

  it('au demarrage, catalogue deja rempli : rien', async () => {
    const { service, importer } = makeJobs({ sets: 28_000 });

    service.onApplicationBootstrap();
    await service.bootRefresh;

    expect(importer.run).not.toHaveBeenCalled();
  });

  it('sous NODE_ENV=test : rien au demarrage', () => {
    const { service, prisma } = makeJobs({ nodeEnv: 'test' });

    service.onApplicationBootstrap();

    expect(service.bootRefresh).toBeNull();
    expect(prisma.legoSet.count).not.toHaveBeenCalled();
  });
});
