import type { Response } from 'supertest';
import { TECHNICAL_LIMITS } from '../src/limits.service';
import { createHarness, Harness, USER_A, USER_B } from './harness';

/*
 * Routes `/internal/*` du catalog et plafonds techniques, contre une vraie base. Ces routes
 * n'existaient pas dans le monolithe (elles remplacent des jointures SQL entre domaines) : ce
 * sont les contrats que `sharing`, le gateway, `search` et `identity` consomment.
 */
describe('routes internes et plafonds (integration)', () => {
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

  const collection = async (user: string, typeCode: string, name = 'c') =>
    (
      await h.as(user).post('/v1/collections').send({ typeCode, name }).expect(201)
    ).body.id as string;

  const tome = (user: string, coll: string, serie: string, volume: number | null) =>
    h
      .as(user)
      .post(`/v1/collections/${coll}/items`)
      .send({ node: { provider: 'mal', externalId: serie }, volume, unifiedData: {} })
      .expect(201)
      .then((r) => r.body as { id: string; nodeId: string });

  it('owner : proprietaire, type et nom ; collection inconnue 404', async () => {
    const id = await collection(USER_A, 'lego', 'Mes LEGO');
    const res = await h.raw().get(`/internal/collections/${id}/owner`).expect(200);
    expect(res.body).toEqual({
      collectionId: id,
      ownerUserId: USER_A,
      typeCode: 'lego',
      name: 'Mes LEGO',
    });
    await h
      .raw()
      .get('/internal/collections/11111111-1111-4111-8111-111111111111/owner')
      .expect(404);
  });

  it('items/count : compte par statuts, ignore les collections inconnues', async () => {
    const coll = await collection(USER_A, 'vinyl', 'v');
    const add = (status?: string) =>
      h
        .as(USER_A)
        .post(`/v1/collections/${coll}/items`)
        .send({ unifiedData: { title: 't' }, ...(status ? { userData: { status } } : {}) })
        .expect(201);
    await add();
    await add('OWNED');
    await add('WISHLIST');
    await add('IGNORED');
    const res = await h
      .raw()
      .post('/internal/items/count')
      .send({
        entries: [
          { collectionId: coll, statuses: ['OWNED'] },
          { collectionId: '11111111-1111-4111-8111-111111111111', statuses: ['OWNED'] },
        ],
      })
      .expect(201);
    expect(res.body.counts).toEqual([{ collectionId: coll, count: 2, name: 'v' }]);
    const all = await h
      .raw()
      .post('/internal/items/count')
      .send({ entries: [{ collectionId: coll, statuses: ['OWNED', 'WISHLIST', 'IGNORED'] }] })
      .expect(201);
    expect(all.body.counts[0].count).toBe(4);
  });

  it('registry/entries : collections, items et noeuds, pagines par curseur', async () => {
    const m = await collection(USER_A, 'manga', 'm');
    const v = await collection(USER_B, 'vinyl', 'v');
    const t = await tome(USER_A, m, '1', 1);
    const seen = { collections: new Set<string>(), items: new Set<string>(), nodes: new Set<string>() };
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: Response = await h
        .raw()
        .get('/internal/registry/entries')
        .query({ limit: 1, ...(cursor ? { cursor } : {}) })
        .expect(200);
      for (const c of res.body.collections) seen.collections.add(c.collectionId);
      for (const r of res.body.resources) {
        (r.kind === 'item' ? seen.items : seen.nodes).add(r.resourceId);
      }
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor && pages < 5);
    expect(pages).toBe(2);
    expect([...seen.collections].sort()).toEqual([m, v].sort());
    expect([...seen.items]).toEqual([t.id]);
    expect([...seen.nodes]).toEqual([t.nodeId]);
  });

  it('nodes et users/:id/nodes : series d un type, volumes possedes tries', async () => {
    const m = await collection(USER_A, 'manga', 'm');
    const a3 = await tome(USER_A, m, '1', 3);
    await tome(USER_A, m, '1', 1);
    await tome(USER_A, m, '1', null);
    const other = await collection(USER_B, 'manga', 'b');
    await tome(USER_B, other, '2', 1);

    const page = await h
      .raw()
      .get('/internal/nodes')
      .query({ typeCode: 'manga', level: 'serie' })
      .expect(200);
    expect(page.body.nodes).toHaveLength(2);

    const mine = await h
      .raw()
      .get(`/internal/users/${USER_A}/nodes`)
      .query({ typeCode: 'manga', level: 'serie' })
      .expect(200);
    expect(mine.body.nodes).toEqual([
      expect.objectContaining({ nodeId: a3.nodeId, volumes: [1, 3] }),
    ]);
  });

  it('RGPD : export puis suppression des donnees d un compte, idempotente, sans toucher aux autres', async () => {
    const m = await collection(USER_A, 'manga', 'a');
    await tome(USER_A, m, '1', 1);
    const v = await collection(USER_B, 'vinyl', 'b');
    await h.as(USER_B).post(`/v1/collections/${v}/items`).send({ unifiedData: { title: 'x' } }).expect(201);

    const exported = await h.raw().get(`/internal/users/${USER_A}/export`).expect(200);
    expect(exported.body.service).toBe('catalog');
    expect(exported.body.data).toMatchObject({
      collections: [expect.objectContaining({ id: m })],
      collectionNodes: [expect.anything()],
      items: [expect.anything()],
    });

    const first = await h.raw().delete(`/internal/users/${USER_A}/data`).expect(200);
    expect(first.body).toEqual({ deleted: 1 });
    expect(await h.db.collection.count({ where: { userId: USER_A } })).toBe(0);
    expect(await h.db.item.count({ where: { userId: USER_A } })).toBe(0);
    expect(await h.db.collectionNode.count({ where: { userId: USER_A } })).toBe(0);
    const again = await h.raw().delete(`/internal/users/${USER_A}/data`).expect(200);
    expect(again.body).toEqual({ deleted: 0 });
    expect(await h.db.item.count({ where: { userId: USER_B } })).toBe(1);
  });

  it(`plafond technique : la ${TECHNICAL_LIMITS.collections + 1}e collection est un 409, l autre compte n est pas concerne`, async () => {
    await h.db.collection.createMany({
      data: Array.from({ length: TECHNICAL_LIMITS.collections }, (_, i) => ({
        userId: USER_A,
        typeCode: 'vinyl',
        name: `c${i}`,
      })),
    });
    await h.as(USER_A).post('/v1/collections').send({ typeCode: 'vinyl', name: 'de trop' }).expect(409);
    expect(await h.db.collection.count({ where: { userId: USER_A } })).toBe(TECHNICAL_LIMITS.collections);
    await h.as(USER_B).post('/v1/collections').send({ typeCode: 'vinyl', name: 'ok' }).expect(201);
  });

  it(`plafond technique : le ${TECHNICAL_LIMITS.nodes + 1}e noeud d un compte est un 409`, async () => {
    const m = await collection(USER_A, 'manga', 'm');
    await h.db.collectionNode.createMany({
      data: Array.from({ length: TECHNICAL_LIMITS.nodes }, (_, i) => ({
        collectionId: m,
        userId: USER_A,
        level: 'serie',
        unifiedData: { title: `s${i}` },
      })),
    });
    await h
      .as(USER_A)
      .post(`/v1/collections/${m}/nodes`)
      .send({ level: 'serie', unifiedData: { title: 'de trop' } })
      .expect(409);
  });
});
