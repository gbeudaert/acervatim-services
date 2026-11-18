import { INestApplication, RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ProblemDetailsExceptionFilter } from '../src/common/filters/problem-details.filter';
import { encodePrincipal } from '../src/common/guards/principal.codec';
import { PRINCIPAL_HEADER } from '../src/common/guards/principal.types';
import { CorrelationIdInterceptor } from '../src/common/interceptors/correlation-id.interceptor';
import {
  CollectionTypeCode,
  InternalAuditRecord,
  InternalCollectionOwner,
  InternalItemCountRequest,
  InternalItemCountResponse,
  ShareStatus,
} from '../src/common/internal/contracts';
import {
  InternalCallError,
  InternalClientService,
} from '../src/common/internal/internal-client.service';
import { PrismaService } from '../src/prisma/prisma.service';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { INTEGRATION_DATABASE } = require('./database-url') as {
  INTEGRATION_DATABASE: string;
};

/**
 * Harnais de la suite d'integration : `sharing` entier sur une vraie base.
 *
 * Ce qui est reel : `AppModule` tel que `main.ts` le monte (prefixe, validation Zod, filtre
 * RFC 9457), les gardes - y compris le decodage du principal signe, avec un vrai principal
 * signe par le secret de test -, les services, le client Prisma et MariaDB.
 *
 * Ce qui est simule : les voisins, et eux seuls. Le client interne (`InternalClientService`)
 * est remplace par `FakeNeighbours`, qui joue les catalogs (`/internal/collections/:id/owner`,
 * `/internal/items/count`) et le journal d'audit d'`identity`. `CatalogClientService` et
 * `AuditClientService` restent les vrais : la table type -> catalog, la diffusion de
 * `findCollection` et le regroupement des comptes par catalog sont donc exerces.
 */

/** Quel catalog sert quel type : la meme table que `catalog-client.service.ts`, vue d'en face. */
const CATALOG_ENV_BY_TYPE: Record<CollectionTypeCode, string> = {
  manga: 'CATALOG_MANGA_BASE_URL',
  vinyl: 'CATALOG_VINYL_BASE_URL',
  lego: 'CATALOG_LEGO_BASE_URL',
  movie: 'CATALOG_GENERIC_BASE_URL',
  book: 'CATALOG_GENERIC_BASE_URL',
  game: 'CATALOG_GENERIC_BASE_URL',
};

function catalogUrl(type: CollectionTypeCode): string {
  return process.env[CATALOG_ENV_BY_TYPE[type]]!;
}

export interface FakeCollection {
  collectionId: string;
  ownerUserId: string;
  typeCode: CollectionTypeCode;
  name: string;
  /** Nombre d'items par statut, de quoi verifier les statuts transmis au comptage. */
  items: Partial<Record<ShareStatus, number>>;
}

export interface RecordedCall {
  baseUrl: string;
  path: string;
  method: string;
  body: unknown;
}

export class FakeNeighbours {
  readonly calls: RecordedCall[] = [];
  readonly audits: InternalAuditRecord[] = [];
  /** Catalogs injoignables au comptage : `tryRequest` rend `null`, comme le vrai client. */
  countsDown = false;
  private readonly collections = new Map<string, FakeCollection>();

  /** Une collection, servie par le catalog de son type. */
  addCollection(
    ownerUserId: string,
    typeCode: CollectionTypeCode,
    name: string,
    items: FakeCollection['items'] = {},
  ): string {
    const collectionId = randomUUID();
    this.collections.set(collectionId, {
      collectionId,
      ownerUserId,
      typeCode,
      name,
      items,
    });
    return collectionId;
  }

  rename(collectionId: string, name: string): void {
    this.collections.get(collectionId)!.name = name;
  }

  countCalls(): RecordedCall[] {
    return this.calls.filter((c) => c.path === '/internal/items/count');
  }

  reset(): void {
    this.calls.length = 0;
    this.audits.length = 0;
    this.countsDown = false;
    this.collections.clear();
  }

  request<T>(
    baseUrl: string,
    path: string,
    opts: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    this.record(baseUrl, path, opts);
    if (path === '/internal/audit') {
      this.audits.push(opts.body as InternalAuditRecord);
      return Promise.resolve(null as T);
    }
    const owner = /^\/internal\/collections\/([^/]+)\/owner$/.exec(path);
    if (owner) {
      const c = this.collections.get(decodeURIComponent(owner[1]));
      // Un catalog qui ne sert pas ce type repond 404, comme celui qui ne la connait pas.
      if (!c || catalogUrl(c.typeCode) !== baseUrl) {
        return Promise.reject(new InternalCallError('internal 404', 404, null));
      }
      const body: InternalCollectionOwner = {
        collectionId: c.collectionId,
        ownerUserId: c.ownerUserId,
        typeCode: c.typeCode,
        name: c.name,
      };
      return Promise.resolve(body as T);
    }
    return Promise.reject(new Error(`appel interne inattendu : ${path}`));
  }

  tryRequest<T>(
    baseUrl: string,
    path: string,
    opts: { method?: string; body?: unknown } = {},
  ): Promise<T | null> {
    this.record(baseUrl, path, opts);
    if (path !== '/internal/items/count') {
      return Promise.reject(new Error(`appel interne inattendu : ${path}`));
    }
    if (this.countsDown) return Promise.resolve(null);
    const { entries } = opts.body as InternalItemCountRequest;
    const counts: InternalItemCountResponse['counts'] = [];
    for (const e of entries) {
      const c = this.collections.get(e.collectionId);
      // Une collection supprimee, ou servie par un autre catalog, est absente de la reponse.
      if (!c || catalogUrl(c.typeCode) !== baseUrl) continue;
      counts.push({
        collectionId: c.collectionId,
        count: e.statuses.reduce((n, s) => n + (c.items[s] ?? 0), 0),
        name: c.name,
      });
    }
    const body: InternalItemCountResponse = { counts };
    return Promise.resolve(body as T);
  }

  private record(
    baseUrl: string,
    path: string,
    opts: { method?: string; body?: unknown },
  ): void {
    this.calls.push({
      baseUrl,
      path,
      method: opts.method ?? 'GET',
      body: opts.body,
    });
  }
}

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';
export type AgentFor = Record<Method, (url: string) => request.Test>;

export interface Harness {
  app: INestApplication;
  db: PrismaService;
  neighbours: FakeNeighbours;
  /** Requete d'un utilisateur, avec un principal signe comme le gateway le signe. */
  as(userId: string, opts?: { premium?: boolean }): AgentFor;
  /** Requete de service a service (`/internal/*`), avec le jeton interne de test. */
  internal(): AgentFor;
  /** Requete sans aucune identite. */
  raw(): ReturnType<typeof request>;
  /** Vide les trois tables et les voisins entre deux tests. */
  clean(): Promise<void>;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const neighbours = new FakeNeighbours();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(InternalClientService)
    .useValue(neighbours)
    .compile();

  const app = moduleRef.createNestApplication({ logger: false });
  // Le montage de `main.ts`, a l'exception de ce qui ne concerne que l'exploitation (helmet,
  // CORS, Swagger).
  app.setGlobalPrefix('v1', {
    exclude: [
      { path: 'health', method: RequestMethod.ALL },
      { path: 'health/(.*)', method: RequestMethod.ALL },
      { path: 'internal/(.*)', method: RequestMethod.ALL },
    ],
  });
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalInterceptors(new CorrelationIdInterceptor());
  app.useGlobalFilters(new ProblemDetailsExceptionFilter());
  await app.init();

  const db = moduleRef.get(PrismaService);
  const server = app.getHttpServer();
  const secret = process.env.INTERNAL_PRINCIPAL_SECRET!;
  const internalToken = process.env.INTERNAL_SERVICE_TOKEN!;

  const agent = (header: string, value: () => string): AgentFor => {
    const verb =
      (m: Method) =>
      (url: string): request.Test =>
        request(server)[m](url).set(header, value());
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
    neighbours,
    as: (userId, opts = {}) =>
      agent(PRINCIPAL_HEADER, () =>
        encodePrincipal(
          {
            userId,
            // Les routes de sharing ne regardent pas le premium : le gate est au gateway.
            // Membre gratuit par defaut, pour le verifier.
            premium: opts.premium ?? false,
            exp: Math.floor(Date.now() / 1000) + 120,
            origin: 'gateway',
          },
          secret,
        ),
      ),
    internal: () => agent('Authorization', () => `Bearer ${internalToken}`),
    raw: () => request(server),
    async clean() {
      const [{ db: current }] = await db.$queryRawUnsafe<{ db: string }[]>(
        'SELECT DATABASE() AS db',
      );
      if (current !== INTEGRATION_DATABASE) {
        throw new Error(`nettoyage refuse : base courante ${current}`);
      }
      await db.$executeRawUnsafe('DELETE FROM collection_share_members');
      await db.$executeRawUnsafe('DELETE FROM collection_share_entries');
      await db.$executeRawUnsafe('DELETE FROM collection_shares');
      neighbours.reset();
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
export const USER_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
