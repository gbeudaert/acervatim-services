import {
  Global,
  INestApplication,
  Injectable,
  Module,
  OnModuleDestroy,
  RequestMethod,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { NextFunction, Request, Response } from 'express';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import {
  CATALOG_CONFIG,
  CatalogCoreModule,
  CatalogConfig,
  legoProfile,
  makeFallbackProfile,
  mangaProfile,
  vinylProfile,
} from '../src';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { integrationDatabaseName, integrationDatabaseUrl } = require('./database-url') as {
  integrationDatabaseName: () => string;
  integrationDatabaseUrl: () => string;
};

/**
 * Harnais de la suite d'integration : le domaine de `catalog-core` sur une vraie base.
 *
 * Ce qui est reel : les controleurs, les services, les gardes, la validation Zod, le client
 * Prisma du catalog et MariaDB - donc chaque requete SQL ecrite a la main. Ce qui est simule :
 * ce que le catalog recoit d'ailleurs.
 *
 * - **L'identite.** En production, le `PrincipalMiddleware` du catalog decode le principal
 *   signe par le gateway. Ici, un middleware de test le lit en clair dans `x-test-principal`.
 *   Le decodage a ses propres tests dans chaque service (`principal.codec.spec.ts`).
 * - **Les voisins.** Le transport interne est un faux : le registre du gateway est seulement
 *   journalise, et `search` repond aux snapshots comme le faisait le faux du monolithe.
 *
 * Les quatre familles de profils sont servies ensemble - vinyle (plat), manga (hierarchique),
 * LEGO (plat) et un type sans profil (`movie`, repli permissif) -, ce qu'aucun catalog ne fait
 * en production, mais que `catalog-core` permet : c'est le meme code pour tous.
 */

export const TEST_PRINCIPAL_HEADER = 'x-test-principal';

export interface TestPrincipal {
  userId: string;
  role?: 'owner' | 'shared';
  statuses?: string[];
}

@Injectable()
export class IntegrationDb extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({ datasourceUrl: integrationDatabaseUrl() });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

export interface RecordedCall {
  baseUrl: string;
  path: string;
  method: string;
  body: unknown;
}

/** Snapshot de `search` pour un provider a adapter : la fiche MAL du faux du monolithe. */
function malSnapshot(externalId: string) {
  return {
    source: 'mal',
    sourceId: externalId,
    mediaType: 'manga',
    title: `Serie ${externalId}`,
    creators: ['Eiichiro Oda'],
    description: 'A long synopsis',
    coverUrl: 'https://example.com/cover.jpg',
    metadata: {
      mean: 8.7,
      media_type: 'manga',
      status: 'currently_publishing',
      num_volumes: 108,
    },
    rawData: { id: Number(externalId) || 0 },
  };
}

export const SNAPSHOT_FETCHED_AT = '2026-05-29T00:00:00.000Z';

@Injectable()
export class FakeTransport {
  readonly calls: RecordedCall[] = [];
  /** `search` injoignable : `tryRequest` rend `null`, comme le vrai client sur une panne. */
  searchDown = false;

  request<T>(
    baseUrl: string,
    path: string,
    opts: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    return Promise.resolve(this.respond(baseUrl, path, opts) as T);
  }

  tryRequest<T>(
    baseUrl: string,
    path: string,
    opts: { method?: string; body?: unknown } = {},
  ): Promise<T | null> {
    return Promise.resolve(this.respond(baseUrl, path, opts) as T | null);
  }

  registryCalls(): RecordedCall[] {
    return this.calls.filter((c) => c.path.startsWith('/internal/registry'));
  }

  reset(): void {
    this.calls.length = 0;
    this.searchDown = false;
  }

  private respond(
    baseUrl: string,
    path: string,
    opts: { method?: string; body?: unknown },
  ): unknown {
    this.calls.push({
      baseUrl,
      path,
      method: opts.method ?? 'GET',
      body: opts.body,
    });
    if (path === '/internal/sources/snapshot') {
      if (this.searchDown) return null;
      const { provider, externalId } = opts.body as {
        provider: string;
        externalId: string;
      };
      if (provider === 'mal') {
        return {
          provider,
          externalId,
          rawData: malSnapshot(externalId),
          fetchedAt: SNAPSHOT_FETCHED_AT,
        };
      }
      return { provider, externalId, rawData: null, fetchedAt: null };
    }
    return null;
  }
}

@Global()
@Module({
  providers: [IntegrationDb, FakeTransport],
  exports: [IntegrationDb, FakeTransport],
})
class IntegrationInfraModule {}

const CONFIG: CatalogConfig = {
  gatewayBaseUrl: 'http://gateway.test',
  searchBaseUrl: 'http://search.test',
};

export interface Harness {
  app: INestApplication;
  db: IntegrationDb;
  transport: FakeTransport;
  /** Requete authentifiee par un principal de test. */
  as(principal: string | TestPrincipal): AgentFor;
  /** Requete sans identite (routes internes). */
  raw(): ReturnType<typeof request>;
  /** Vide les trois tables entre deux tests. */
  clean(): Promise<void>;
  close(): Promise<void>;
}

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';
export type AgentFor = Record<Method, (url: string) => request.Test>;

export async function createHarness(): Promise<Harness> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      IntegrationInfraModule,
      CatalogCoreModule.register({
        profiles: [
          vinylProfile,
          mangaProfile,
          legoProfile,
          makeFallbackProfile('movie'),
        ],
        db: IntegrationDb,
        internalTransport: FakeTransport,
        configFactory: { provide: CATALOG_CONFIG, useValue: CONFIG },
      }),
    ],
  }).compile();

  const app = moduleRef.createNestApplication({ logger: false });
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const raw = req.headers[TEST_PRINCIPAL_HEADER];
    if (typeof raw === 'string') {
      const principal = JSON.parse(raw) as TestPrincipal;
      const r = req as unknown as {
        principal: TestPrincipal & { premium: boolean };
        userId: string;
      };
      r.principal = { premium: true, ...principal };
      r.userId = principal.userId;
    }
    next();
  });
  app.setGlobalPrefix('v1', {
    exclude: [{ path: 'internal/(.*)', method: RequestMethod.ALL }],
  });
  app.useGlobalPipes(new ZodValidationPipe());
  await app.init();

  const db = moduleRef.get(IntegrationDb);
  const transport = moduleRef.get(FakeTransport);
  const server = app.getHttpServer();

  const as = (p: string | TestPrincipal): AgentFor => {
    const principal = typeof p === 'string' ? { userId: p } : p;
    const header = JSON.stringify(principal);
    const verb =
      (m: Method) =>
      (url: string): request.Test =>
        request(server)[m](url).set(TEST_PRINCIPAL_HEADER, header);
    return {
      get: verb('get'),
      post: verb('post'),
      patch: verb('patch'),
      put: verb('put'),
      delete: verb('delete'),
    };
  };

  return {
    app,
    db,
    transport,
    as,
    raw: () => request(server),
    async clean() {
      const name = integrationDatabaseName();
      const [{ db: current }] = await db.$queryRawUnsafe<{ db: string }[]>(
        'SELECT DATABASE() AS db',
      );
      if (current !== name || !current.endsWith('_it')) {
        throw new Error(`nettoyage refuse : base courante ${current}`);
      }
      await db.$executeRawUnsafe('DELETE FROM items');
      await db.$executeRawUnsafe('DELETE FROM collection_nodes');
      await db.$executeRawUnsafe('DELETE FROM collections');
      transport.reset();
    },
    async close() {
      await app.close();
    },
  };
}

/** Identifiants d'utilisateurs de test : des UUID, comme ceux qu'emet `identity`. */
export const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const USER_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
