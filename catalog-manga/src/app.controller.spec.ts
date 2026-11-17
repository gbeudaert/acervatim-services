import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import type {
  CatalogInternalService,
  ProfileRegistry,
} from '../catalog-core/src';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { READINESS_TIMEOUT_MS } from './common/health/readiness';

/*
 * Sondes de vie et de disponibilite. La seconde est celle de la bascule : base injoignable
 * ou muette, elle doit repondre `503` - et jamais rester suspendue.
 *
 * `catalog-core` est remplace par deux classes vides : AppService n'en consomme que deux
 * services, fournis ici en simulacres. Charger le vrai index tirerait toute la
 * bibliotheque - et, avec la jonction de `link-core`, depuis un chemin hors de `/app` ou
 * jest ne resout plus ses dependances.
 */
jest.mock('../catalog-core/src', () => ({
  CatalogInternalService: class {},
  ProfileRegistry: class {},
}));

type Counts = { collections: number; nodes: number; items: number };

function make(counts: () => Promise<Counts>) {
  const internal = { counts: jest.fn(counts) };
  const profiles = { codes: jest.fn().mockReturnValue(['manga']) };
  const config = { get: jest.fn().mockReturnValue(undefined) };
  const controller = new AppController(
    new AppService(
      internal as unknown as CatalogInternalService,
      profiles as unknown as ProfileRegistry,
      config as unknown as ConfigService,
    ),
  );
  const res = { status: jest.fn() };
  return {
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

  it('base joignable : 200, le mode autonome ne compte pas', async () => {
    const { ready, res } = make(() =>
      Promise.resolve({ collections: 1, nodes: 2, items: 3 }),
    );
    await expect(ready()).resolves.toMatchObject({
      status: 'ok',
      db: true,
      counts: { collections: 1, nodes: 2, items: 3 },
      registry: false,
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
      types: ['manga'],
      counts: null,
    });
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('base muette : 503 au bout du delai, la sonde ne reste pas suspendue', async () => {
    jest.useFakeTimers();
    const { ready, res } = make(() => new Promise<Counts>(() => undefined));
    const report = ready();
    await jest.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);
    await expect(report).resolves.toMatchObject({
      status: 'unavailable',
      db: false,
    });
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('la sonde de vie ne sollicite pas la base', () => {
    const { health, internal } = make(() =>
      Promise.reject(new Error('base arretee')),
    );
    expect(health()).toEqual({
      status: 'ok',
      service: 'acervatim-catalog-manga',
    });
    expect(internal.counts).not.toHaveBeenCalled();
  });
});
