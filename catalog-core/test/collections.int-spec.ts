import type { Response } from 'supertest';
import { createHarness, Harness, USER_A, USER_B } from './harness';

/*
 * Collections, contre une vraie base. Equivalent de `collections/collections.service.spec.ts`
 * du monolithe (qui simulait Prisma), plus ce que la simulation ne pouvait pas verifier : la
 * requete SQL des filtres `items[in]` / `items[all]`, et la pagination reelle.
 */
describe('collections (integration)', () => {
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

  const create = async (user: string, typeCode: string, name: string) => {
    const res = await h
      .as(user)
      .post('/v1/collections')
      .send({ typeCode, name })
      .expect(201);
    return res.body.id as string;
  };

  it('cree une collection, la renvoie avec `type` (pas typeId) et l enregistre au gateway', async () => {
    const res = await h
      .as(USER_A)
      .post('/v1/collections')
      .send({ typeCode: 'vinyl', name: 'Mes vinyles', description: 'jazz' })
      .expect(201);
    expect(res.body).toMatchObject({
      userId: USER_A,
      name: 'Mes vinyles',
      description: 'jazz',
      itemCount: 0,
      type: 'vinyl',
    });
    expect(res.body.typeId).toBeUndefined();
    expect(h.transport.registryCalls()).toEqual([
      expect.objectContaining({
        method: 'PUT',
        body: {
          collections: [
            { collectionId: res.body.id, userId: USER_A, typeCode: 'vinyl' },
          ],
        },
      }),
    ]);
  });

  it('type que ce catalog ne sert pas : 400, rien n est cree', async () => {
    await h
      .as(USER_A)
      .post('/v1/collections')
      .send({ typeCode: 'book', name: 'x' })
      .expect(400);
    expect(await h.db.collection.count()).toBe(0);
  });

  it('corps hors schema : 400', async () => {
    await h
      .as(USER_A)
      .post('/v1/collections')
      .send({ typeCode: 'vinyl', name: 'x', extra: true })
      .expect(400);
    await h
      .as(USER_A)
      .post('/v1/collections')
      .send({ typeCode: 'vinyl', name: '' })
      .expect(400);
  });

  // Isolation en lecture : dans la constellation, c'est le gateway qui refuse un tiers (404),
  // apres avoir demande a `sharing`. Le catalog le refuse aussi, en defense en profondeur : un
  // principal sans role `shared` doit etre le proprietaire (collection-access.guard.ts). Les
  // ecritures restent en plus scopees sur l'utilisateur : voir PATCH et DELETE plus bas.
  it('lit sa collection ; une collection inexistante ou d un autre compte est un 404', async () => {
    const id = await create(USER_A, 'vinyl', 'a moi');
    const own = await h.as(USER_A).get(`/v1/collections/${id}`).expect(200);
    expect(own.body).toMatchObject({ id, type: 'vinyl', hierarchy: [] });
    await h
      .as(USER_A)
      .get('/v1/collections/11111111-1111-4111-8111-111111111111')
      .expect(404);
    await h.as(USER_B).get(`/v1/collections/${id}`).expect(404);
    // Meme reponse avec un role `owner` signe pour un autre compte : le role ne remplace pas
    // la propriete.
    await h.as({ userId: USER_B, role: 'owner' }).get(`/v1/collections/${id}`).expect(404);
  });

  it('liste ses collections seulement, filtre type[in]', async () => {
    const vinyl = await create(USER_A, 'vinyl', 'v');
    const manga = await create(USER_A, 'manga', 'm');
    await create(USER_B, 'vinyl', 'autre compte');

    const all = await h.as(USER_A).get('/v1/collections').expect(200);
    expect(all.body.data.map((c: { id: string }) => c.id).sort()).toEqual(
      [vinyl, manga].sort(),
    );

    const filtered = await h
      .as(USER_A)
      .get('/v1/collections')
      .query({ 'type[in]': 'manga' })
      .expect(200);
    expect(filtered.body.data.map((c: { id: string }) => c.id)).toEqual([
      manga,
    ]);

    await h
      .as(USER_A)
      .get('/v1/collections')
      .query({ 'type[in]': 'inconnu' })
      .expect(400);
  });

  it('pagination : curseur, page partielle a nextCursor null, ordre stable', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await create(USER_A, 'vinyl', `c${i}`));

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: Response = await h
        .as(USER_A)
        .get('/v1/collections')
        .query({ limit: 2, ...(cursor ? { cursor } : {}) })
        .expect(200);
      seen.push(...res.body.data.map((c: { id: string }) => c.id));
      cursor = res.body.meta.pagination.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
    expect(seen.sort()).toEqual(ids.sort());
  });

  describe('items[in] / items[all] : la requete SQL sur unified_data', () => {
    let jazz: string;
    let rock: string;
    let mixed: string;

    beforeEach(async () => {
      jazz = await create(USER_A, 'vinyl', 'jazz');
      rock = await create(USER_A, 'vinyl', 'rock');
      mixed = await create(USER_A, 'vinyl', 'mixte');
      const add = (coll: string, unifiedData: Record<string, unknown>) =>
        h
          .as(USER_A)
          .post(`/v1/collections/${coll}/items`)
          .send({ unifiedData })
          .expect(201);
      await add(jazz, { title: 'Kind of Blue', creators: ['Miles Davis'] });
      await add(rock, { title: 'Abbey Road' });
      await add(mixed, { title: 'Bitches Brew' });
      await add(mixed, { title: 'Abbey Road (remaster)' });
      // Meme titre chez un autre compte : ne doit jamais remonter.
      const other = await create(USER_B, 'vinyl', 'b');
      await h
        .as(USER_B)
        .post(`/v1/collections/${other}/items`)
        .send({ unifiedData: { title: 'Abbey Road' } })
        .expect(201);
    });

    const ids = async (query: Record<string, string>) => {
      const res = await h
        .as(USER_A)
        .get('/v1/collections')
        .query(query)
        .expect(200);
      return (res.body.data as { id: string }[]).map((c) => c.id).sort();
    };

    it('items[in] : union, insensible a la casse et aux accents de collation', async () => {
      expect(await ids({ 'items[in]': 'abbey' })).toEqual(
        [rock, mixed].sort(),
      );
      expect(await ids({ 'items[in]': 'ABBEY,blue' })).toEqual(
        [jazz, rock, mixed].sort(),
      );
    });

    it('items[all] : intersection par terme', async () => {
      expect(await ids({ 'items[all]': 'abbey,brew' })).toEqual([mixed]);
    });

    it('sans correspondance : page vide', async () => {
      expect(await ids({ 'items[in]': 'introuvable' })).toEqual([]);
    });

    it('les jokers LIKE de la saisie sont des caracteres, pas des motifs', async () => {
      expect(await ids({ 'items[in]': '%' })).toEqual([]);
      expect(await ids({ 'items[in]': '_bbey' })).toEqual([]);
    });
  });

  it('PATCH : renomme sa collection ; celle d un autre compte reste intacte (404)', async () => {
    const id = await create(USER_A, 'vinyl', 'avant');
    const res = await h
      .as(USER_A)
      .patch(`/v1/collections/${id}`)
      .send({ name: 'apres' })
      .expect(200);
    expect(res.body.name).toBe('apres');
    await h
      .as(USER_B)
      .patch(`/v1/collections/${id}`)
      .send({ name: 'vol' })
      .expect(404);
    expect((await h.db.collection.findUnique({ where: { id } }))?.name).toBe(
      'apres',
    );
  });

  it('DELETE : supprime en cascade, desenregistre ; un autre compte recoit 404', async () => {
    const id = await create(USER_A, 'manga', 'a supprimer');
    await h
      .as(USER_A)
      .post(`/v1/collections/${id}/items`)
      .send({
        node: { provider: 'mal', externalId: '13' },
        volume: 1,
        unifiedData: {},
      })
      .expect(201);
    await h.as(USER_B).delete(`/v1/collections/${id}`).expect(404);
    h.transport.reset();

    await h.as(USER_A).delete(`/v1/collections/${id}`).expect(204);
    expect(await h.db.collection.count()).toBe(0);
    expect(await h.db.item.count()).toBe(0);
    expect(await h.db.collectionNode.count()).toBe(0);
    expect(
      h.transport.registryCalls().some((c) => c.method === 'DELETE'),
    ).toBe(true);
  });
});
