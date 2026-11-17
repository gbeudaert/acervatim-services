import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateKeyPairSync } from 'crypto';
import { Request } from 'express';
import jwt from 'jsonwebtoken';
import { PaymentRequiredException } from '../common/errors';
import { decodePrincipal } from '../common/guards/principal.codec';
import { InternalAccess, ShareStatus } from '../common/internal/contracts';
import { RouteMatch } from '../routing/route-matcher';
import { RouteRule } from '../routing/route-table';
import { AccessResolverService } from './access-resolver.service';
import { PremiumCacheService } from './premium-cache.service';
import { PrincipalService } from './principal.service';

/*
 * Le gate premium et la resolution d'acces, qui ont quitte les catalogs pour le gateway (3.1 et
 * 3.6). Equivalent des scenarios « gate premium (S2) » de `items/items.e2e.spec.ts` et de la
 * partie acces de `sharing/shared-read.e2e.spec.ts` du monolithe : ce que l'app recoit (402,
 * 403, 404, 400) se decide ici, avant que la requete n'atteigne un catalog.
 */

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STRANGER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const COLLECTION = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const SECRET = 'secret-de-test-du-principal-signe-0123456789';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const token = (sub: string) =>
  jwt.sign({ sub }, privateKey, { algorithm: 'RS256', expiresIn: '1h' });

const rule = (over: Partial<RouteRule>): RouteRule => ({
  methods: ['GET'],
  pattern: '/v1/items/:id',
  target: { kind: 'catalog:ref', via: 'item', param: 'id' },
  auth: 'user',
  premium: 'owner',
  ...over,
});

const READ_ITEM: RouteMatch = { rule: rule({}), params: { id: ITEM } };
const WRITE_ITEM: RouteMatch = {
  rule: rule({ methods: ['PATCH'], write: true }),
  params: { id: ITEM },
};
const LIST_COLLECTIONS: RouteMatch = {
  rule: rule({
    pattern: '/v1/collections',
    target: { kind: 'catalog:scatter' },
    premium: 'requester',
  }),
  params: {},
};
const ME: RouteMatch = {
  rule: rule({
    pattern: '/v1/me',
    target: { kind: 'service', service: 'identity' },
    premium: 'none',
  }),
  params: {},
};

function make(opts: {
  premium?: string[];
  access?: (userId: string) => InternalAccess | null;
}) {
  const premiumUsers = new Set(opts.premium ?? []);
  const premium = {
    isPremium: jest.fn((userId: string) =>
      Promise.resolve(premiumUsers.has(userId)),
    ),
  };
  const access = {
    resolve: jest.fn((userId: string) =>
      Promise.resolve(opts.access ? opts.access(userId) : null),
    ),
  };
  const env: Record<string, unknown> = {
    JWT_PUBLIC_KEY: publicKey,
    INTERNAL_PRINCIPAL_SECRET: SECRET,
    INTERNAL_PRINCIPAL_TTL: 120,
  };
  const config = {
    get: jest.fn((k: string, d?: unknown) => env[k] ?? d),
  } as unknown as ConfigService;
  const svc = new PrincipalService(
    config,
    premium as unknown as PremiumCacheService,
    access as unknown as AccessResolverService,
  );
  svc.onModuleInit();
  return { svc, premium, access };
}

const req = (sub?: string, collectionId: string | null = COLLECTION) =>
  ({
    headers: sub ? { authorization: `Bearer ${token(sub)}` } : {},
    resolvedCollectionId: collectionId ?? undefined,
    requestId: 'r-1',
  }) as unknown as Request;

const owner = (statuses?: ShareStatus[]) => (userId: string) =>
  userId === OWNER
    ? {
        collectionId: COLLECTION,
        ownerUserId: OWNER,
        role: 'owner' as const,
        statuses: ['OWNED', 'WISHLIST', 'IGNORED'] as ShareStatus[],
      }
    : userId === MEMBER && statuses
      ? {
          collectionId: COLLECTION,
          ownerUserId: OWNER,
          role: 'shared' as const,
          statuses,
        }
      : null;

describe('PrincipalService - gate premium (S2)', () => {
  it('sans premium : 402 sur l ecriture ET sur la lecture de ses propres donnees', async () => {
    const { svc } = make({ premium: [], access: owner() });
    await expect(svc.resolve(req(OWNER), READ_ITEM)).rejects.toBeInstanceOf(
      PaymentRequiredException,
    );
    await expect(svc.resolve(req(OWNER), WRITE_ITEM)).rejects.toBeInstanceOf(
      PaymentRequiredException,
    );
    await expect(
      svc.resolve(req(OWNER), LIST_COLLECTIONS),
    ).rejects.toBeInstanceOf(PaymentRequiredException);
  });

  it('avec premium : le proprietaire passe, principal signe role owner', async () => {
    const { svc } = make({ premium: [OWNER], access: owner() });
    const res = await svc.resolve(req(OWNER), WRITE_ITEM);
    expect(res).toMatchObject({ userId: OWNER, collectionId: COLLECTION });
    const p = decodePrincipal(res.principalHeader!, SECRET);
    expect(p).toMatchObject({ userId: OWNER, role: 'owner', premium: true });
  });

  it('une route sans gate transmet le statut sans refuser', async () => {
    const { svc } = make({ premium: [] });
    const res = await svc.resolve(req(OWNER), ME);
    expect(decodePrincipal(res.principalHeader!, SECRET)).toMatchObject({
      userId: OWNER,
      premium: false,
    });
  });
});

describe('PrincipalService - acces a une collection (S4, S5)', () => {
  it('le gate de lecture regarde le PROPRIETAIRE, pas le requerant', async () => {
    // Membre gratuit, proprietaire premium : la lecture passe.
    const { svc, premium } = make({
      premium: [OWNER],
      access: owner(['OWNED']),
    });
    const res = await svc.resolve(req(MEMBER), READ_ITEM);
    expect(premium.isPremium).toHaveBeenCalledWith(OWNER);
    const p = decodePrincipal(res.principalHeader!, SECRET);
    expect(p).toMatchObject({
      userId: MEMBER,
      role: 'shared',
      statuses: ['OWNED'],
      premium: false,
    });
  });

  it('le proprietaire qui perd son premium suspend le partage : 402 pour le membre', async () => {
    const { svc } = make({ premium: [MEMBER], access: owner(['OWNED']) });
    await expect(svc.resolve(req(MEMBER), READ_ITEM)).rejects.toBeInstanceOf(
      PaymentRequiredException,
    );
  });

  it('lecture seule : 403 sur toute ecriture d un membre, avant meme le premium', async () => {
    const { svc, premium } = make({
      premium: [OWNER, MEMBER],
      access: owner(['OWNED', 'WISHLIST', 'IGNORED']),
    });
    await expect(svc.resolve(req(MEMBER), WRITE_ITEM)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(premium.isPremium).not.toHaveBeenCalled();
  });

  it('un tiers, ou un membre revoque ou ejecte : 404, jamais 403', async () => {
    const { svc } = make({ premium: [OWNER, STRANGER], access: owner() });
    await expect(svc.resolve(req(STRANGER), READ_ITEM)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.resolve(req(STRANGER), WRITE_ITEM)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('ressource inconnue du registre : 404', async () => {
    const { svc, access } = make({ premium: [OWNER], access: owner() });
    await expect(
      svc.resolve(req(OWNER, null), READ_ITEM),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(access.resolve).not.toHaveBeenCalled();
  });

  it('un identifiant malforme reste un 400, il n est pas transforme en 404', async () => {
    const { svc, access } = make({ premium: [OWNER], access: owner() });
    await expect(
      svc.resolve(req(OWNER), { ...READ_ITEM, params: { id: 'pas-un-uuid' } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(access.resolve).not.toHaveBeenCalled();
  });

  it('les statuts viennent de sharing, jamais de la requete', async () => {
    const { svc } = make({ premium: [OWNER], access: owner(['WISHLIST']) });
    const forged = req(MEMBER);
    forged.headers['x-share-scope'] = 'all';
    forged.headers['x-acervatim-principal'] = 'forge';
    const res = await svc.resolve(forged, READ_ITEM);
    expect(decodePrincipal(res.principalHeader!, SECRET).statuses).toEqual([
      'WISHLIST',
    ]);
  });
});

describe('PrincipalService - identite', () => {
  it('sans jeton ou jeton invalide : 401', async () => {
    const { svc } = make({ premium: [OWNER], access: owner() });
    await expect(svc.resolve(req(), READ_ITEM)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    const bad = req(OWNER);
    bad.headers.authorization = 'Bearer pas-un-jwt';
    await expect(svc.resolve(bad, READ_ITEM)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    const other = jwt.sign(
      { sub: OWNER },
      generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      }).privateKey,
      { algorithm: 'RS256' },
    );
    const forged = req();
    forged.headers.authorization = `Bearer ${other}`;
    await expect(svc.resolve(forged, READ_ITEM)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('une route publique ou admin ne signe aucun principal', async () => {
    const { svc } = make({});
    await expect(
      svc.resolve(req(), { ...ME, rule: { ...ME.rule, auth: 'public' } }),
    ).resolves.toEqual({});
    await expect(
      svc.resolve(req(OWNER), { ...ME, rule: { ...ME.rule, auth: 'admin' } }),
    ).resolves.toEqual({});
  });
});
