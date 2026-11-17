import { BadGatewayException } from '@nestjs/common';
import { Response } from 'express';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { READINESS_TIMEOUT_MS } from './common/health/readiness';
import {
  InternalCallError,
  InternalClientService,
} from './common/internal/internal-client.service';
import { PremiumCacheService } from './principal/premium-cache.service';
import { PrismaService } from './prisma/prisma.service';
import { ServiceRegistryService } from './routing/service-registry.service';

/*
 * Sondes de vie et de disponibilite du gateway. La seconde est celle de la bascule : sa base
 * injoignable ou muette, elle doit repondre `503` - et jamais rester suspendue. Un service
 * aval ou Redis qui manque n'est qu'une degradation : le reste des routes est servi.
 */

/** Etat simule d'un service aval : pret, vivant sans base, ou eteint. */
type Downstream = 'ready' | 'unavailable' | 'down';

function make(
  opts: {
    count?: () => Promise<number>;
    redis?: boolean;
    downstream?: (baseUrl: string) => Downstream;
  } = {},
) {
  const count = jest.fn(opts.count ?? (() => Promise.resolve(2)));
  const prisma = {
    collectionRegistry: { count },
    resourceRegistry: { count },
  };
  const services = { find: jest.fn((name: string) => `http://${name}:3000`) };
  const internal = {
    request: jest.fn((baseUrl: string) => {
      const state = opts.downstream?.(baseUrl) ?? 'ready';
      if (state === 'ready') return Promise.resolve({ status: 'ok' });
      if (state === 'unavailable') {
        return Promise.reject(
          new InternalCallError('internal 503', 503, { status: 'unavailable' }),
        );
      }
      return Promise.reject(new BadGatewayException('internal call failed'));
    }),
  };
  const premium = {
    isRedisAvailable: jest.fn().mockReturnValue(opts.redis ?? true),
  };
  const controller = new AppController(
    new AppService(
      prisma as unknown as PrismaService,
      services as unknown as ServiceRegistryService,
      internal as unknown as InternalClientService,
      premium as unknown as PremiumCacheService,
    ),
  );
  const res = { status: jest.fn() };
  return {
    count,
    internal,
    res,
    ready: () => controller.ready(res as unknown as Response),
    health: () => controller.health(),
  };
}

describe('AppController - sondes', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('tout repond : 200 et statut ok', async () => {
    const { ready, res } = make();
    const report = await ready();
    expect(report).toMatchObject({
      status: 'ok',
      db: true,
      redis: true,
      registry: { collections: 2, resources: 2 },
    });
    expect(report.services).toHaveLength(8);
    expect(report.services.every((s) => s.reachable && s.ready)).toBe(true);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('base injoignable : 503, le detail des services reste dans le corps', async () => {
    const { ready, res } = make({
      count: () =>
        Promise.reject(new Error("Can't reach database server at db:3306")),
    });
    const report = await ready();
    expect(report).toMatchObject({
      status: 'unavailable',
      db: false,
      registry: null,
    });
    expect(report.services).toHaveLength(8);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('base muette : 503 au bout du delai, la sonde ne reste pas suspendue', async () => {
    jest.useFakeTimers();
    const { ready, res } = make({
      count: () => new Promise<number>(() => undefined),
    });
    const report = ready();
    await jest.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);
    await expect(report).resolves.toMatchObject({
      status: 'unavailable',
      db: false,
    });
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('service aval sans base : 200 degraded, joignable mais pas pret', async () => {
    const { ready, res } = make({
      downstream: (url) =>
        url.includes('catalog-vinyl') ? 'unavailable' : 'ready',
    });
    const report = await ready();
    expect(report.status).toBe('degraded');
    expect(report.services).toContainEqual({
      service: 'catalog-vinyl',
      configured: true,
      reachable: true,
      ready: false,
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('service aval eteint : ni joignable ni pret', async () => {
    const { ready } = make({
      downstream: (url) => (url.includes('billing') ? 'down' : 'ready'),
    });
    const report = await ready();
    expect(report.status).toBe('degraded');
    expect(report.services).toContainEqual({
      service: 'billing',
      configured: true,
      reachable: false,
      ready: false,
    });
  });

  it('Redis absent : 200 et statut degraded', async () => {
    const { ready, res } = make({ redis: false });
    await expect(ready()).resolves.toMatchObject({
      status: 'degraded',
      db: true,
      redis: false,
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('interroge la sonde de disponibilite des services aval, au-dela de leur propre delai', async () => {
    const { ready, internal } = make();
    await ready();
    expect(internal.request).toHaveBeenCalledTimes(8);
    for (const [, path, opts] of internal.request.mock.calls as unknown as [
      string,
      string,
      { timeoutMs: number },
    ][]) {
      expect(path).toBe('/health/ready');
      expect(opts.timeoutMs).toBeGreaterThan(READINESS_TIMEOUT_MS);
    }
  });

  it('la sonde de vie ne sollicite ni la base ni les services aval', () => {
    const { health, count, internal } = make({
      count: () => Promise.reject(new Error('base arretee')),
    });
    expect(health()).toEqual({ status: 'ok', service: 'acervatim-gateway' });
    expect(count).not.toHaveBeenCalled();
    expect(internal.request).not.toHaveBeenCalled();
  });
});
