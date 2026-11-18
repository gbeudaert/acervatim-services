import type { Response } from 'supertest';
import {
  createHarness,
  Harness,
  USER_A,
  USER_B,
  USER_C,
  USER_D,
} from './harness';

/*
 * Les routes internes de sharing, contre une vraie base.
 *
 * `GET /internal/access` est la resolution que le gateway signe dans le principal (3.1) :
 * c'est ici que se decide qui lit quoi d'une collection partagee. Equivalent de la partie
 * acces de `sharing/shared-read.e2e.spec.ts` du monolithe (« fin d'acces », « etancheite »),
 * et de `CollectionAccessService`, qui n'avait pas de test a lui. La traduction de ces statuts
 * en items visibles est au catalog (catalog-core/test/shared-read.int-spec.ts), et le passage
 * du 404 au public par le gateway dans `principal.service.spec.ts`.
 *
 * Puis les deux participations a la saga RGPD : export (equivalent du dernier scenario de
 * `sharing.e2e.spec.ts`) et suppression.
 */

describe('routes internes (integration)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.clean();
  });

  const share = async (
    owner: string,
    collections: { collectionId: string; statuses: string[] }[],
    extra: Record<string, unknown> = {},
  ): Promise<{ id: string; code: string }> => {
    const res: Response = await h
      .as(owner)
      .post('/v1/shares')
      .send({ collections, maxUses: 10, ...extra })
      .expect(201);
    return { id: res.body.id as string, code: res.body.code as string };
  };

  const join = (userId: string, code: string, label?: string) =>
    h
      .as(userId)
      .post('/v1/shares/redeem')
      .send(label === undefined ? { code } : { code, label })
      .expect(200);

  const access = (userId: string, collectionId: string) =>
    h
      .internal()
      .get(`/internal/access?userId=${userId}&collectionId=${collectionId}`);

  describe('GET /internal/access', () => {
    it('le proprietaire voit tout ; un membre, les statuts de son partage', async () => {
      const coll = h.neighbours.addCollection(USER_A, 'manga', 'Mangas');
      const { code } = await share(USER_A, [
        { collectionId: coll, statuses: ['OWNED'] },
      ]);
      await join(USER_B, code);

      await access(USER_A, coll).expect(200, {
        collectionId: coll,
        ownerUserId: USER_A,
        role: 'owner',
        statuses: ['OWNED', 'WISHLIST', 'IGNORED'],
      });
      await access(USER_B, coll).expect(200, {
        collectionId: coll,
        ownerUserId: USER_A,
        role: 'shared',
        statuses: ['OWNED'],
      });
    });

    it('un tiers, une collection inconnue ou non partagee : 404, indistinguables', async () => {
      const shared = h.neighbours.addCollection(USER_A, 'vinyl', 'Partagee');
      const kept = h.neighbours.addCollection(USER_A, 'vinyl', 'Gardee');
      const { code } = await share(USER_A, [
        { collectionId: shared, statuses: ['OWNED'] },
      ]);
      await join(USER_B, code);

      const stranger: Response = await access(USER_C, shared).expect(404);
      const notShared: Response = await access(USER_B, kept).expect(404);
      const unknown: Response = await access(
        USER_B,
        '11111111-1111-4111-8111-111111111111',
      ).expect(404);
      // Meme reponse, a l'URL et a l'identifiant de requete pres.
      const answer = (r: Response) => ({
        type: r.body.type as string,
        title: r.body.title as string,
        detail: r.body.detail as string,
      });
      expect(answer(notShared)).toEqual(answer(stranger));
      expect(answer(unknown)).toEqual(answer(stranger));
    });

    it('deux partages vivants de la meme collection : le membre voit la reunion', async () => {
      const coll = h.neighbours.addCollection(USER_A, 'vinyl', 'Vinyles');
      const owned = await share(USER_A, [
        { collectionId: coll, statuses: ['OWNED'] },
      ]);
      const wanted = await share(USER_A, [
        { collectionId: coll, statuses: ['WISHLIST'] },
      ]);
      await join(USER_B, owned.code);
      await join(USER_B, wanted.code);

      const both: Response = await access(USER_B, coll).expect(200);
      expect(both.body.statuses).toEqual(['OWNED', 'WISHLIST']);

      // Revoquer l'un laisse l'autre : la reunion se reduit, l'acces demeure.
      await h.as(USER_A).delete(`/v1/shares/${wanted.id}`).expect(204);
      const one: Response = await access(USER_B, coll).expect(200);
      expect(one.body.statuses).toEqual(['OWNED']);
    });

    it('revoquer le partage ou ejecter le membre coupe l acces aussitot', async () => {
      const coll = h.neighbours.addCollection(USER_A, 'vinyl', 'Vinyles');
      const s = await share(USER_A, [
        { collectionId: coll, statuses: ['OWNED', 'WISHLIST'] },
      ]);
      await join(USER_B, s.code);
      await join(USER_C, s.code);

      await h
        .as(USER_A)
        .delete(`/v1/shares/${s.id}/members/${USER_B}`)
        .expect(204);
      await access(USER_B, coll).expect(404);
      await access(USER_C, coll).expect(200);

      await h.as(USER_A).delete(`/v1/shares/${s.id}`).expect(204);
      await access(USER_C, coll).expect(404);
      // Le proprietaire, lui, garde sa collection.
      await access(USER_A, coll).expect(200);
    });

    it('l expiration borne le code, pas l adhesion deja acquise', async () => {
      const coll = h.neighbours.addCollection(USER_A, 'vinyl', 'Vinyles');
      const s = await share(USER_A, [
        { collectionId: coll, statuses: ['OWNED'] },
      ]);
      await join(USER_B, s.code);
      // Le partage expire apres l'adhesion de B.
      await h.db.collectionShare.update({
        where: { id: s.id },
        data: { expiresAt: BigInt(Date.now() - 1000) },
      });

      await access(USER_B, coll).expect(200);
      await h
        .as(USER_C)
        .post('/v1/shares/redeem')
        .send({ code: s.code })
        .expect(404);
      await access(USER_C, coll).expect(404);
    });

    it('une ligne abimee ne montre rien : pas d acces, plutot qu un acces vide', async () => {
      const coll = h.neighbours.addCollection(USER_A, 'vinyl', 'Vinyles');
      const s = await share(USER_A, [
        { collectionId: coll, statuses: ['OWNED'] },
      ]);
      await join(USER_B, s.code);
      await h.db.collectionShareEntry.updateMany({
        where: { shareId: s.id },
        data: { statuses: ['owned', 'TOUT'] },
      });
      await access(USER_B, coll).expect(404);
    });

    it('sans le jeton interne : 401', async () => {
      const coll = h.neighbours.addCollection(USER_A, 'vinyl', 'Vinyles');
      const url = `/internal/access?userId=${USER_A}&collectionId=${coll}`;
      await h.raw().get(url).expect(401);
      await h
        .raw()
        .get(url)
        .set('Authorization', 'Bearer jeton-interne-de-test-faux0')
        .expect(401);
      // Un principal d'utilisateur n'ouvre pas les routes internes.
      await h.as(USER_A).get(url).expect(401);
    });
  });

  describe('saga RGPD', () => {
    it('l export contient les deux sens du partage, jamais le hash du code', async () => {
      const coll = h.neighbours.addCollection(
        USER_A,
        'vinyl',
        'Vinyles du salon',
      );
      const s = await share(
        USER_A,
        [{ collectionId: coll, statuses: ['OWNED', 'WISHLIST'] }],
        { label: 'Partage avec Alice', expiresAt: 4102444800000 },
      );
      await join(USER_B, s.code, 'Chez Alice');
      const hash = (
        await h.db.collectionShare.findUniqueOrThrow({ where: { id: s.id } })
      ).codeHash;

      const ownerExport: Response = await h
        .internal()
        .get(`/internal/users/${USER_A}/export`)
        .expect(200);
      expect(ownerExport.body.service).toBe('sharing');
      const owner = ownerExport.body.data;
      expect(owner.collectionShares).toHaveLength(1);
      expect(owner.collectionShares[0]).not.toHaveProperty('codeHash');
      // Son libelle est sa donnee : il sort dans SON export.
      expect(owner.collectionShares[0]).toMatchObject({
        id: s.id,
        label: 'Partage avec Alice',
        expiresAt: 4102444800000,
        entries: [
          {
            collectionId: coll,
            statuses: ['OWNED', 'WISHLIST'],
            collectionName: 'Vinyles du salon',
          },
        ],
        members: [expect.objectContaining({ memberUserId: USER_B })],
      });
      expect(owner.shareMemberships).toEqual([]);
      // ... mais pas celui du membre.
      expect(JSON.stringify(owner)).not.toContain('Chez Alice');
      expect(JSON.stringify(owner)).not.toContain(hash);

      const memberExport: Response = await h
        .internal()
        .get(`/internal/users/${USER_B}/export`)
        .expect(200);
      const member = memberExport.body.data;
      expect(member.collectionShares).toEqual([]);
      expect(member.shareMemberships).toEqual([
        expect.objectContaining({
          shareId: s.id,
          label: 'Chez Alice',
          share: {
            entries: [
              {
                collectionId: coll,
                statuses: ['OWNED', 'WISHLIST'],
                collectionName: 'Vinyles du salon',
              },
            ],
          },
        }),
      ]);
      expect(JSON.stringify(member)).not.toContain('Partage avec Alice');
      expect(JSON.stringify(member)).not.toContain(hash);
    });

    it('la suppression retire ses partages et ses adhesions, pas ceux des autres', async () => {
      // A partage a B et D ; B partage a C. On supprime B.
      const a = h.neighbours.addCollection(USER_A, 'vinyl', 'De A');
      const b = h.neighbours.addCollection(USER_B, 'manga', 'De B');
      const fromA = await share(USER_A, [
        { collectionId: a, statuses: ['OWNED'] },
      ]);
      const fromB = await share(USER_B, [
        { collectionId: b, statuses: ['OWNED'] },
      ]);
      await join(USER_B, fromA.code);
      await join(USER_D, fromA.code);
      await join(USER_C, fromB.code);

      const first: Response = await h
        .internal()
        .delete(`/internal/users/${USER_B}/data`)
        .expect(200);
      // Une adhesion (a A) et un partage (le sien) ; l'adhesion de C part avec, en cascade.
      expect(first.body).toEqual({ deleted: 2 });

      expect(
        await h.db.collectionShare.findUnique({ where: { id: fromB.id } }),
      ).toBeNull();
      expect(
        await h.db.collectionShareEntry.count({ where: { shareId: fromB.id } }),
      ).toBe(0);
      expect(
        await h.db.collectionShareMember.count({
          where: { shareId: fromB.id },
        }),
      ).toBe(0);

      const kept = await h.db.collectionShare.findUniqueOrThrow({
        where: { id: fromA.id },
        include: { members: true },
      });
      expect(kept.members.map((m) => m.memberUserId)).toEqual([USER_D]);
      // La place consommee par B n'est pas rendue au code d'A.
      expect(kept.usedCount).toBe(2);
      await access(USER_D, a).expect(200);
      await access(USER_C, b).expect(404);

      // Idempotent : la saga peut rejouer l'etape.
      await h
        .internal()
        .delete(`/internal/users/${USER_B}/data`)
        .expect(200, { deleted: 0 });
    });
  });
});
