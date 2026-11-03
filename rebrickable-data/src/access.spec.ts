import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { AdminController } from './admin/admin.controller';
import { AdminGuard } from './common/guards/admin.guard';
import { InternalGuard } from './common/guards/internal.guard';
import { InternalController } from './internal/internal.controller';

// Matrice I/O de la spec : tout appel `/internal/*` ou `/admin/*` sans le bon jeton = 401.
// Fichier a part des specs de controleurs : ce verrou ne doit pas disparaitre avec elles.

function ctxWith(authorization?: string): ExecutionContext {
  const req = { headers: authorization === undefined ? {} : { authorization } };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe.each([
  {
    name: 'InternalController',
    controller: InternalController,
    makeGuard: (token: string) => new InternalGuard(configWith(token)),
    guard: InternalGuard,
  },
  {
    name: 'AdminController',
    controller: AdminController,
    makeGuard: (token: string) => new AdminGuard(configWith(token)),
    guard: AdminGuard,
  },
])('$name : acces', ({ controller, makeGuard, guard }) => {
  const TOKEN = 'service-token-0123456789';

  function ready() {
    const g = makeGuard(TOKEN);
    g.onModuleInit();
    return g;
  }

  it('est protege sur toute la classe', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toEqual([guard]);
  });

  it('sans jeton : 401', () => {
    expect(() => ready().canActivate(ctxWith())).toThrow(UnauthorizedException);
  });

  it('jeton faux : 401', () => {
    expect(() =>
      ready().canActivate(ctxWith('Bearer service-token-9876543210')),
    ).toThrow(UnauthorizedException);
  });

  it('bon jeton : accepte', () => {
    expect(ready().canActivate(ctxWith(`Bearer ${TOKEN}`))).toBe(true);
  });
});

function configWith(token: string): ConfigService {
  return { get: () => token } as unknown as ConfigService;
}
