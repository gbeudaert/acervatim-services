import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { READINESS_TIMEOUT_MS } from './common/health/readiness';
import { RedisHealthService } from './common/redis/redis-health.service';
import { PrismaService } from './prisma/prisma.service';

/*
 * Sondes de vie et de disponibilite. La seconde est celle de la bascule : base injoignable
 * ou muette, elle doit repondre `503` - et jamais rester suspendue. Redis absent n'arrete
 * que le moissonnage Brickset : une degradation, pas une panne.
 */

function make(count: () => Promise<number>, redis = true) {
  const prisma = { legoSet: { count: jest.fn(count) } };
  const redisHealth = { isAvailable: jest.fn().mockReturnValue(redis) };
  const config = { get: jest.fn().mockReturnValue(undefined) };
  const controller = new AppController(
    new AppService(
      prisma as unknown as PrismaService,
      redisHealth as unknown as RedisHealthService,
      config as unknown as ConfigService,
    ),
  );
  const res = { status: jest.fn() };
  return {
    prisma,
    res,
    ready: () => controller.ready(res as unknown as Response),
    health: () => controller.health(),
  };
}

describe('AppController - sondes', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('base et Redis joignables : 200 et statut ok', async () => {
    const { ready, res } = make(() => Promise.resolve(3));
    await expect(ready()).resolves.toMatchObject({
      status: 'ok',
      db: true,
      redis: true,
      sets: 3,
      brickset: false,
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('base injoignable : 503, le diagnostic reste dans le corps', async () => {
    const { ready, res } = make(() =>
      Promise.reject(new Error("Can't reach database server at db:3306")),
    );
    await expect(ready()).resolves.toMatchObject({
      status: 'unavailable',
      db: false,
      redis: true,
      sets: null,
    });
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('base muette : 503 au bout du delai, la sonde ne reste pas suspendue', async () => {
    jest.useFakeTimers();
    const { ready, res } = make(() => new Promise<number>(() => undefined));
    const report = ready();
    await jest.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);
    await expect(report).resolves.toMatchObject({
      status: 'unavailable',
      db: false,
    });
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('Redis absent : 200 et statut degraded', async () => {
    const { ready, res } = make(() => Promise.resolve(3), false);
    await expect(ready()).resolves.toMatchObject({
      status: 'degraded',
      db: true,
      redis: false,
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('la sonde de vie ne sollicite pas la base', () => {
    const { health, prisma } = make(() =>
      Promise.reject(new Error('base arretee')),
    );
    expect(health()).toEqual({
      status: 'ok',
      service: 'acervatim-rebrickable-data',
    });
    expect(prisma.legoSet.count).not.toHaveBeenCalled();
  });
});
