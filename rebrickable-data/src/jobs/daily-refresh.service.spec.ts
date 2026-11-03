import { ConfigService } from '@nestjs/config';
import { BricksetHarvestService } from '../brickset/brickset-harvest.service';
import { ApiCacheService } from '../common/cache/api-cache.service';
import { RebrickableCsvService } from '../import/rebrickable-csv.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  DAILY_REFRESH_CRON,
  DailyRefreshService,
} from './daily-refresh.service';

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
  const harvest = {
    run: jest
      .fn()
      .mockResolvedValue({ state: 'skipped', rowsUpserted: 0, unmatched: 0 }),
  };
  const cache = { pruneExpired: jest.fn().mockResolvedValue(0) };
  const config = {
    get: () => opts.nodeEnv ?? 'development',
  } as unknown as ConfigService;
  const service = new DailyRefreshService(
    prisma as unknown as PrismaService,
    importer as unknown as RebrickableCsvService,
    harvest as unknown as BricksetHarvestService,
    cache as unknown as ApiCacheService,
    config,
  );
  return { service, prisma, importer, harvest, cache };
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

  it('enchaine import puis moissonnage, dans cet ordre', async () => {
    const { service, importer, harvest, cache } = makeJobs({});

    await service.daily();

    expect(importer.run.mock.invocationCallOrder[0]).toBeLessThan(
      harvest.run.mock.invocationCallOrder[0],
    );
    expect(cache.pruneExpired).toHaveBeenCalled();
  });

  it.each([
    ['unchanged', importResult('unchanged')],
    ['failed', importResult('failed')],
    [
      'en exception',
      jest.fn().mockRejectedValue(new Error('base injoignable')),
    ],
  ])('moissonne meme si l import est %s', async (_label, importer) => {
    const { service, harvest } = makeJobs({ importer });

    const report = await service.refresh('test');

    expect(harvest.run).toHaveBeenCalledTimes(1);
    expect(report.harvest).toMatchObject({ state: 'skipped' });
  });

  it('au demarrage, catalogue vide : import puis moissonnage en tache de fond', async () => {
    const { service, importer, harvest } = makeJobs({ sets: 0 });

    service.onApplicationBootstrap();
    await service.bootRefresh;

    expect(importer.run).toHaveBeenCalledTimes(1);
    expect(harvest.run).toHaveBeenCalledTimes(1);
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
