import {
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue, QueueEvents } from 'bullmq';
import { ApiCacheService } from '../common/cache/api-cache.service';
import { HttpClientService } from '../common/http/http-client.service';
import { RedisHealthService } from '../common/redis/redis-health.service';
import { BricksetProcessor } from './brickset.processor';
import {
  BricksetBudgetExhaustedError,
  BricksetService,
  budgetKey,
} from './brickset.service';
import { BricksetFetchJobData } from './brickset.types';

// Aucune connexion Redis dans les tests : seuls les evenements de file sont simules.
jest.mock('bullmq', () => ({
  ...jest.requireActual('bullmq'),
  QueueEvents: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn(),
  })),
}));

const API_KEY = 'secret-brickset-key';
const BUDGET = 90;
const PARAMS = { query: '5702015869935', pageNumber: 1, pageSize: 20 };

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    BRICKSET_API_KEY: API_KEY,
    BRICKSET_BASE_URL: 'https://brickset.example.test/api/v3.asmx/',
    BRICKSET_DAILY_CALL_BUDGET: BUDGET,
    ...overrides,
  };
  return {
    get: (key: string, fallback?: unknown) => values[key] ?? fallback,
  } as unknown as ConfigService;
}

function makeService(opts: { used?: number; redis?: boolean; body?: unknown }) {
  const cache = {
    get: jest
      .fn()
      .mockResolvedValue(opts.used === undefined ? null : { count: opts.used }),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const job = {
    waitUntilFinished: jest
      .fn()
      .mockResolvedValue(opts.body ?? { status: 'success', sets: [] }),
  };
  const queue = { add: jest.fn().mockResolvedValue(job) };
  const redisHealth = { isAvailable: () => opts.redis ?? true };
  const service = new BricksetService(
    makeConfig(),
    cache as unknown as ApiCacheService,
    redisHealth as unknown as RedisHealthService,
    queue as unknown as Queue<BricksetFetchJobData, unknown>,
  );
  service.onModuleInit();
  return { service, cache, queue };
}

describe('BricksetService.getSets', () => {
  afterEach(() => jest.useRealTimers());

  it('leve BricksetBudgetExhaustedError quand le compteur du jour vaut le budget', async () => {
    const { service, cache, queue } = makeService({ used: BUDGET });

    await expect(service.getSets(PARAMS)).rejects.toBeInstanceOf(
      BricksetBudgetExhaustedError,
    );
    expect(queue.add).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('ecrit used + 1 AVANT d enfiler', async () => {
    const { service, cache, queue } = makeService({ used: 5 });

    await service.getSets(PARAMS);

    expect(cache.set).toHaveBeenCalledWith(
      expect.stringMatching(/^brickset:budget:\d{4}-\d{2}-\d{2}$/),
      { count: 6 },
      48 * 3600,
    );
    expect(cache.set.mock.invocationCallOrder[0]).toBeLessThan(
      queue.add.mock.invocationCallOrder[0],
    );
  });

  it('n enfile que les parametres getSets : la cle API n entre pas dans Redis', async () => {
    const { service, queue } = makeService({});

    await service.getSets(PARAMS);

    const [, data] = queue.add.mock.calls[0];
    expect(data).toEqual({ params: PARAMS });
    expect(JSON.stringify(queue.add.mock.calls[0])).not.toContain(API_KEY);
  });

  it('BadGateway sur un corps non success', async () => {
    const { service } = makeService({
      body: { status: 'error', message: 'Invalid parameter' },
    });

    await expect(service.getSets(PARAMS)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('"API limit exceeded" : budget epuise et compteur du jour sature', async () => {
    const { service, cache } = makeService({
      used: 12,
      body: { status: 'error', message: 'API limit exceeded' },
    });

    await expect(service.getSets(PARAMS)).rejects.toBeInstanceOf(
      BricksetBudgetExhaustedError,
    );
    expect(cache.set).toHaveBeenLastCalledWith(
      expect.any(String),
      { count: BUDGET },
      48 * 3600,
    );
  });

  it('Redis indisponible : aucune unite consommee', async () => {
    const { service, cache, queue } = makeService({ used: 3, redis: false });

    await expect(service.getSets(PARAMS)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(cache.set).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('lit et ecrit sous la meme cle, meme si minuit UTC passe entre les deux', async () => {
    jest.useFakeTimers({
      now: new Date('2026-11-03T23:59:59.900Z'),
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
    const { service, cache } = makeService({});
    cache.get.mockImplementation(async () => {
      // La lecture se termine apres minuit.
      jest.setSystemTime(new Date('2026-11-04T00:00:00.100Z'));
      return { count: 7 };
    });

    await service.getSets(PARAMS);

    expect(cache.get).toHaveBeenCalledWith('brickset:budget:2026-11-03');
    expect(cache.set).toHaveBeenCalledWith(
      'brickset:budget:2026-11-03',
      { count: 8 },
      48 * 3600,
    );
  });

  it('ecoute les erreurs de la file d evenements (une panne Redis ne fait pas tomber le processus)', () => {
    makeService({});
    const events = (QueueEvents as unknown as jest.Mock).mock.results.at(-1)!
      .value as { on: jest.Mock };
    expect(events.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('deux appels simultanes : les reservations passent une a une, aucune unite perdue', async () => {
    const { service, cache } = makeService({});
    // Compteur partage : chaque lecture voit l'ecriture precedente seulement si les
    // reservations sont serialisees.
    let stored = 10;
    cache.get.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { count: stored };
    });
    cache.set.mockImplementation(async (_k: string, v: { count: number }) => {
      stored = v.count;
    });

    await Promise.all([service.getSets(PARAMS), service.getSets(PARAMS)]);

    expect(stored).toBe(12);
  });

  it('un refus de budget n empeche pas la reservation suivante', async () => {
    const { service, cache } = makeService({});
    cache.get
      .mockResolvedValueOnce({ count: BUDGET })
      .mockResolvedValueOnce({ count: 0 });

    await expect(service.getSets(PARAMS)).rejects.toBeInstanceOf(
      BricksetBudgetExhaustedError,
    );
    await expect(service.getSets(PARAMS)).resolves.toMatchObject({
      status: 'success',
    });
  });

  it('budgetKey : jour UTC', () => {
    expect(budgetKey(new Date('2026-11-03T23:30:00-02:00'))).toBe(
      'brickset:budget:2026-11-04',
    );
  });
});

describe('BricksetProcessor', () => {
  function makeProcessor(config = makeConfig()) {
    const http = {
      request: jest.fn().mockResolvedValue({ status: 200, data: { ok: 1 } }),
    };
    const processor = new BricksetProcessor(
      http as unknown as HttpClientService,
      config,
    );
    return { processor, http };
  }

  it('ajoute la cle depuis la configuration et ne tente qu une fois', async () => {
    const { processor, http } = makeProcessor();

    const res = await processor.process({
      data: { params: PARAMS },
    } as Job<BricksetFetchJobData, unknown>);

    expect(res).toEqual({ ok: 1 });
    const [url, opts] = http.request.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      'https://brickset.example.test/api/v3.asmx/getSets',
    );
    expect(parsed.searchParams.get('apiKey')).toBe(API_KEY);
    expect(JSON.parse(parsed.searchParams.get('params')!)).toEqual(PARAMS);
    expect(opts).toMatchObject({ maxAttempts: 1 });
  });

  it('sans cle : echoue sans appel', async () => {
    const { processor, http } = makeProcessor(
      makeConfig({ BRICKSET_API_KEY: '' }),
    );

    await expect(
      processor.process({ data: { params: PARAMS } } as Job<
        BricksetFetchJobData,
        unknown
      >),
    ).rejects.toThrow('BRICKSET_API_KEY');
    expect(http.request).not.toHaveBeenCalled();
  });
});
