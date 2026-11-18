import type { Response } from 'supertest';
import {
  createHarness,
  Harness,
  SNAPSHOT_FETCHED_AT,
  USER_A,
  USER_B,
} from './harness';

/*
 * Items et noeuds, contre une vraie base. Equivalent de `items/items.e2e.spec.ts` du monolithe
 * (scenarios repris un a un, dans le meme ordre), plus le type `lego`. Les tests du gate
 * premium de ce fichier ne sont pas ici : le premium se decide desormais au gateway (3.6), et
 * ses tests y sont (`principal.service.spec.ts`).
 *
 * Difference attendue avec le monolithe : les erreurs ne passent pas ici par le filtre RFC 9457
 * du service (il vit dans le socle de chaque catalog, pas dans `catalog-core`). Les tests
 * verifient donc le statut HTTP, pas l'URI `type` du corps.
 */
describe('items et noeuds (integration)', () => {
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

  const collection = async (user: string, typeCode: string, name = 'c') => {
    const res = await h
      .as(user)
      .post('/v1/collections')
      .send({ typeCode, name })
      .expect(201);
    return res.body.id as string;
  };

  it('vinyl (plat) : create -> liste legere -> detail cure -> PATCH -> source -> /sources -> delete', async () => {
    const a = h.as(USER_A);
    const coll = await collection(USER_A, 'vinyl', 'Mes vinyles');

    const created = await a
      .post(`/v1/collections/${coll}/items`)
      .send({ unifiedData: { title: 'Hollow Knight OST', creators: ['Larkin'] } })
      .expect(201);
    expect(created.body.nodeId).toBeNull();
    expect(created.body.volume).toBeNull();
    expect(created.body.unifiedData).toMatchObject({
      type: 'vinyl',
      title: 'Hollow Knight OST',
    });
    expect(created.body.sources).toEqual([]);
    const itemId = created.body.id as string;

    const list = await a.get(`/v1/collections/${coll}/items`).expect(200);
    expect(list.body.data[0]).toEqual({
      id: itemId,
      type: 'vinyl',
      title: 'Hollow Knight OST',
      coverUrl: null,
      creators: ['Larkin'],
      genre: [],
      releaseDate: null,
      status: 'OWNED',
      playCount: 0,
    });

    const patched = await a
      .patch(`/v1/items/${itemId}`)
      .send({ unifiedData: { title: 'Hollow Knight OST (Deluxe)' } })
      .expect(200);
    expect(patched.body.unifiedData.title).toBe('Hollow Knight OST (Deluxe)');

    await a
      .post(`/v1/items/${itemId}/sources`)
      .send({ provider: 'isbn', externalId: '9782723492607' })
      .expect(201);
    const detail = await a.get(`/v1/items/${itemId}`).expect(200);
    expect(detail.body.sources).toEqual([
      { provider: 'isbn', externalId: '9782723492607', fetchedAt: null },
    ]);
    expect(detail.body.sources[0].rawData).toBeUndefined();
    const sources = await a.get(`/v1/items/${itemId}/sources`).expect(200);
    expect(sources.body[0]).toMatchObject({
      provider: 'isbn',
      externalId: '9782723492607',
      rawData: null,
    });

    await a.delete(`/v1/items/${itemId}`).expect(204);
    const after = await a.get(`/v1/collections/${coll}`).expect(200);
    expect(after.body.itemCount).toBe(0);
    expect(after.body.hierarchy).toEqual([]);
  });

  it('vinyl autorise les doublons (pas de contrainte noeud/volume)', async () => {
    const coll = await collection(USER_A, 'vinyl');
    const body = { unifiedData: { title: 'Same' } };
    await h.as(USER_A).post(`/v1/collections/${coll}/items`).send(body).expect(201);
    await h.as(USER_A).post(`/v1/collections/${coll}/items`).send(body).expect(201);
    expect(await h.db.item.count()).toBe(2);
  });

  it('manga : tome (noeud + volume) 201 ; meme (noeud, volume) 409 ; hierarchie, drill-down, purge', async () => {
    const a = h.as(USER_A);
    const coll = await collection(USER_A, 'manga', 'Mes mangas');
    const node = { provider: 'mal', externalId: '13' };

    const t1 = await a
      .post(`/v1/collections/${coll}/items`)
      .send({ node, volume: 1, unifiedData: { title: 'One Piece - T.1' } })
      .expect(201);
    expect(t1.body.volume).toBe(1);
    expect(t1.body.nodeId).not.toBeNull();
    const nodeId = t1.body.nodeId as string;

    await a
      .post(`/v1/collections/${coll}/items`)
      .send({ node, volume: 2, unifiedData: {} })
      .expect(201);
    await a
      .post(`/v1/collections/${coll}/items`)
      .send({ node, volume: 1, unifiedData: {} })
      .expect(409);

    const detail = await a.get(`/v1/collections/${coll}`).expect(200);
    expect(detail.body.hierarchy).toEqual([
      { key: 'serie', label: 'Série', count: 1 },
    ]);

    const nodes = await a
      .get(`/v1/collections/${coll}/nodes?level=serie`)
      .expect(200);
    expect(nodes.body.data).toHaveLength(1);
    expect(nodes.body.data[0]).toMatchObject({
      id: nodeId,
      level: 'serie',
      title: 'Serie 13',
      author: 'Eiichiro Oda',
      status: 'ongoing',
      totalCount: 108,
      rating: 8.7,
      ownedCount: 2,
      isWishlist: false,
    });
    expect(nodes.body.data[0].sources).toEqual([
      { provider: 'mal', externalId: '13', fetchedAt: SNAPSHOT_FETCHED_AT },
    ]);

    const drill = await a
      .get(`/v1/collections/${coll}/items?nodeId=${nodeId}`)
      .expect(200);
    expect(drill.body.data).toHaveLength(2);
    expect(drill.body.data[0]).toMatchObject({ type: 'manga', serie: 'Serie 13' });

    for (const id of drill.body.data.map((d: { id: string }) => d.id)) {
      await a.delete(`/v1/items/${id}`).expect(204);
    }
    await a.get(`/v1/nodes/${nodeId}`).expect(404);
    expect(await h.db.collectionNode.count()).toBe(0);
  });

  it('?nodeId refuse sur un type plat (400) ; serie en wishlist conservee vide, purgee hors wishlist', async () => {
    const a = h.as(USER_A);
    const vinyl = await collection(USER_A, 'vinyl', 'flat');
    await a
      .get(`/v1/collections/${vinyl}/items?nodeId=11111111-1111-4111-8111-111111111111`)
      .expect(400);

    const manga = await collection(USER_A, 'manga', 'wl');
    const created = await a
      .post(`/v1/collections/${manga}/nodes`)
      .send({
        level: 'serie',
        source: { provider: 'mal', externalId: '21' },
        isWishlist: true,
      })
      .expect(201);
    expect(created.body).toMatchObject({
      level: 'serie',
      title: 'Serie 21',
      totalCount: 108,
      ownedCount: 0,
      isWishlist: true,
    });
    const nodeId = created.body.id as string;
    await a.get(`/v1/nodes/${nodeId}`).expect(200);

    const patched = await a
      .patch(`/v1/nodes/${nodeId}`)
      .send({ note: 5, comment: 'top' })
      .expect(200);
    expect(patched.body.userData).toEqual({ note: 5, comment: 'top' });

    await a.patch(`/v1/nodes/${nodeId}`).send({ isWishlist: false }).expect(204);
    await a.get(`/v1/nodes/${nodeId}`).expect(404);
  });

  it('manga saisi a la main : serie sans provider, tomes par nodeId, deplacement et purge', async () => {
    const a = h.as(USER_A);
    const coll = await collection(USER_A, 'manga', 'Saisie manuelle');
    const serie = await a
      .post(`/v1/collections/${coll}/nodes`)
      .send({
        level: 'serie',
        unifiedData: {
          title: 'Vinland Saga',
          author: 'Makoto Yukimura',
          status: 'ongoing',
          totalCount: 27,
        },
      })
      .expect(201);
    expect(serie.body).toMatchObject({
      level: 'serie',
      title: 'Vinland Saga',
      author: 'Makoto Yukimura',
      status: 'ongoing',
      totalCount: 27,
      ownedCount: 0,
      sources: [],
    });
    const serieId = serie.body.id as string;

    const t1 = await a
      .post(`/v1/collections/${coll}/items`)
      .send({
        nodeId: serieId,
        volume: 1,
        unifiedData: { title: 'Vinland Saga - T.1', publisherFr: 'Kurokawa' },
      })
      .expect(201);
    expect(t1.body).toMatchObject({ nodeId: serieId, volume: 1 });
    await a
      .post(`/v1/collections/${coll}/items`)
      .send({ nodeId: serieId, volume: null, unifiedData: { title: 'Artbook' } })
      .expect(201);

    // Une serie d'une autre collection : 404, pas 400.
    const otherColl = await collection(USER_A, 'manga', 'autre');
    await a
      .post(`/v1/collections/${otherColl}/items`)
      .send({ nodeId: serieId, volume: 1, unifiedData: {} })
      .expect(404);

    const nodes = await a
      .get(`/v1/collections/${coll}/nodes?level=serie`)
      .expect(200);
    expect(nodes.body.data).toHaveLength(1);
    expect(nodes.body.data[0]).toMatchObject({
      id: serieId,
      title: 'Vinland Saga',
      ownedCount: 2,
    });

    await a.patch(`/v1/items/${t1.body.id}`).send({ nodeId: null }).expect(200);
    const drill = await a
      .get(`/v1/collections/${coll}/items?nodeId=${serieId}`)
      .expect(200);
    expect(drill.body.data).toHaveLength(1);
    await a
      .patch(`/v1/items/${drill.body.data[0].id}`)
      .send({ nodeId: null })
      .expect(200);
    await a.get(`/v1/nodes/${serieId}`).expect(404);

    // Rien ne decrit une serie sans provider ni unifiedData.
    await a
      .post(`/v1/collections/${coll}/nodes`)
      .send({ level: 'serie' })
      .expect(400);
  });

  it('PATCH deplace un tome vers une autre serie ; (serie, volume) deja pris : 409', async () => {
    const a = h.as(USER_A);
    const coll = await collection(USER_A, 'manga');
    const serie = (title: string) =>
      a
        .post(`/v1/collections/${coll}/nodes`)
        .send({ level: 'serie', unifiedData: { title } })
        .expect(201)
        .then((r) => r.body.id as string);
    const s1 = await serie('S1');
    const s2 = await serie('S2');
    const t1 = await a
      .post(`/v1/collections/${coll}/items`)
      .send({ nodeId: s1, volume: 1, unifiedData: {} })
      .expect(201);
    await a
      .post(`/v1/collections/${coll}/items`)
      .send({ nodeId: s2, volume: 1, unifiedData: {} })
      .expect(201);
    const t1bis = await a
      .post(`/v1/collections/${coll}/items`)
      .send({ nodeId: s1, volume: 2, unifiedData: {} })
      .expect(201);

    await a
      .patch(`/v1/items/${t1bis.body.id}`)
      .send({ nodeId: s2, volume: 1 })
      .expect(409);
    const moved = await a
      .patch(`/v1/items/${t1bis.body.id}`)
      .send({ nodeId: s2, volume: 2 })
      .expect(200);
    expect(moved.body).toMatchObject({ nodeId: s2, volume: 2 });
    // La serie de depart garde son tome 1, elle n'est pas purgee.
    await a.get(`/v1/nodes/${s1}`).expect(200);
    expect(t1.body.nodeId).toBe(s1);
  });

  it('nodeId, volume et node refuses sur un type plat (400), a la creation comme au PATCH', async () => {
    const a = h.as(USER_A);
    const coll = await collection(USER_A, 'vinyl');
    await a
      .post(`/v1/collections/${coll}/items`)
      .send({ unifiedData: { title: 'x' }, volume: 1 })
      .expect(400);
    await a
      .post(`/v1/collections/${coll}/items`)
      .send({
        unifiedData: { title: 'x' },
        nodeId: '11111111-1111-4111-8111-111111111111',
      })
      .expect(400);
    await a
      .post(`/v1/collections/${coll}/items`)
      .send({ unifiedData: { title: 'x' }, node: { provider: 'mal', externalId: '1' } })
      .expect(400);
    const item = await a
      .post(`/v1/collections/${coll}/items`)
      .send({ unifiedData: { title: 'x' } })
      .expect(201);
    await a.patch(`/v1/items/${item.body.id}`).send({ volume: 2 }).expect(400);
  });

  it('filtre ?provider[in]= sur sources[] des items (JSON_CONTAINS)', async () => {
    const a = h.as(USER_A);
    const coll = await collection(USER_A, 'vinyl', 'prov');
    const withMal = await a
      .post(`/v1/collections/${coll}/items`)
      .send({
        unifiedData: { title: 'A' },
        sources: [{ provider: 'mal', externalId: 'm1' }],
      })
      .expect(201);
    const withDiscogs = await a
      .post(`/v1/collections/${coll}/items`)
      .send({
        unifiedData: { title: 'B' },
        sources: [{ provider: 'discogs', externalId: 'd1' }],
      })
      .expect(201);
    await a
      .post(`/v1/collections/${coll}/items`)
      .send({ unifiedData: { title: 'C' } })
      .expect(201);

    const one = await a
      .get(`/v1/collections/${coll}/items`)
      .query({ 'provider[in]': 'mal' })
      .expect(200);
    expect(one.body.data.map((i: { id: string }) => i.id)).toEqual([
      withMal.body.id,
    ]);
    const two = await a
      .get(`/v1/collections/${coll}/items`)
      .query({ 'provider[in]': 'mal,discogs' })
      .expect(200);
    expect(two.body.data.map((i: { id: string }) => i.id).sort()).toEqual(
      [withMal.body.id, withDiscogs.body.id].sort(),
    );
    await a
      .get(`/v1/collections/${coll}/items`)
      .query({ 'provider[in]': 'inconnu' })
      .expect(400);
  });

  it('round-trip vinyl : un item avec TOUS les champs se relit sans perte', async () => {
    const a = h.as(USER_A);
    const coll = await collection(USER_A, 'vinyl', 'miroir');
    const unifiedData = {
      title: 'Kind of Blue',
      creators: ['Miles Davis', 'John Coltrane'],
      genre: ['Jazz', 'Modal'],
      label: 'Columbia',
      format: 'LP',
      recordingSpeed: 'RPM_33',
      country: 'US',
      releaseDate: '1959-08-17',
      coverUrl: 'https://example.test/kob.jpg',
    };
    const userData = {
      rating: 5,
      purchasePrice: 34.9,
      lastPlayedAt: '2026-08-01T20:30:00.000Z',
      note: 'Pressage original, pochette usee',
      status: 'OWNED',
    };
    const created = await a
      .post(`/v1/collections/${coll}/items`)
      .send({
        unifiedData,
        userData,
        sources: [
          { provider: 'barcode', externalId: '0888072024557' },
          { provider: 'discogs', externalId: '1234567' },
        ],
      })
      .expect(201);
    const itemId = created.body.id as string;

    const reread = await a.get(`/v1/items/${itemId}`).expect(200);
    expect(reread.body.unifiedData).toEqual({ type: 'vinyl', ...unifiedData });
    expect(reread.body.userData).toEqual(userData);
    expect(reread.body.sources).toEqual([
      { provider: 'barcode', externalId: '0888072024557', fetchedAt: null },
      { provider: 'discogs', externalId: '1234567', fetchedAt: null },
    ]);

    await a
      .patch(`/v1/items/${itemId}`)
      .send({ unifiedData: { ...unifiedData, label: 'Columbia (reissue)' } })
      .expect(200);
    const after = await a.get(`/v1/items/${itemId}`).expect(200);
    expect(after.body.unifiedData).toEqual({
      type: 'vinyl',
      ...unifiedData,
      label: 'Columbia (reissue)',
    });
    expect(after.body.userData).toEqual(userData);
  });

  it('round-trip lego : une boite se relit sans perte, la liste projette son numero et son theme', async () => {
    const a = h.as(USER_A);
    const coll = await collection(USER_A, 'lego', 'Mes LEGO');
    const unifiedData = {
      title: 'Cat D11 Bulldozer',
      setNumber: '42131',
      year: 2021,
      theme: 'Technic',
      themeId: 1,
      numParts: 3854,
      minifigs: 0,
      coverUrl: 'https://cdn.rebrickable.com/media/sets/42131-1.jpg',
    };
    const created = await a
      .post(`/v1/collections/${coll}/items`)
      .send({
        unifiedData,
        userData: { status: 'WISHLIST', note: 'boite scellee' },
        sources: [
          { provider: 'rebrickable', externalId: '42131-1' },
          { provider: 'barcode', externalId: '5702016914320' },
        ],
      })
      .expect(201);
    const reread = await a.get(`/v1/items/${created.body.id}`).expect(200);
    expect(reread.body.unifiedData).toEqual({ type: 'lego', ...unifiedData });

    const list = await a.get(`/v1/collections/${coll}/items`).expect(200);
    expect(list.body.data[0]).toEqual({
      id: created.body.id,
      type: 'lego',
      title: 'Cat D11 Bulldozer',
      setNumber: '42131',
      year: 2021,
      theme: 'Technic',
      coverUrl: unifiedData.coverUrl,
      status: 'WISHLIST',
    });

    const filtered = await a
      .get(`/v1/collections/${coll}/items`)
      .query({ 'provider[in]': 'rebrickable' })
      .expect(200);
    expect(filtered.body.data).toHaveLength(1);

    // Le code-barres n'est pas un champ cure : sa place est dans sources[].
    await a
      .post(`/v1/collections/${coll}/items`)
      .send({ unifiedData: { title: 'X', barcode: '5702016914320' } })
      .expect(400);
  });

  it('releaseDate : un push qui ne connait que l annee ne degrade pas une date precise', async () => {
    const a = h.as(USER_A);
    const coll = await collection(USER_A, 'vinyl', 'dates');
    const created = await a
      .post(`/v1/collections/${coll}/items`)
      .send({ unifiedData: { title: 'Kind of Blue', releaseDate: '1959-08-17' } })
      .expect(201);
    const itemId = created.body.id as string;
    const patched = await a
      .patch(`/v1/items/${itemId}`)
      .send({ unifiedData: { title: 'Kind of Blue', releaseDate: '1959-01-01' } })
      .expect(200);
    expect(patched.body.unifiedData.releaseDate).toBe('1959-08-17');
    const moved = await a
      .patch(`/v1/items/${itemId}`)
      .send({ unifiedData: { title: 'Kind of Blue', releaseDate: '1960-01-01' } })
      .expect(200);
    expect(moved.body.unifiedData.releaseDate).toBe('1960-01-01');
  });

  it('round-trip noeud serie : note et commentaire se relisent, merge partiel, bornes appliquees', async () => {
    const a = h.as(USER_A);
    const coll = await collection(USER_A, 'manga', 'series');
    const created = await a
      .post(`/v1/collections/${coll}/nodes`)
      .send({ level: 'serie', source: { provider: 'mal', externalId: '31' } })
      .expect(201);
    const nodeId = created.body.id as string;

    await a.patch(`/v1/nodes/${nodeId}`).send({ note: 9, comment: 'A relire' }).expect(200);
    const reread = await a.get(`/v1/nodes/${nodeId}`).expect(200);
    expect(reread.body.userData).toEqual({ note: 9, comment: 'A relire' });
    expect(reread.body).toMatchObject({ title: 'Serie 31', totalCount: 108 });

    await a.patch(`/v1/nodes/${nodeId}`).send({ comment: 'Relu' }).expect(200);
    const merged = await a.get(`/v1/nodes/${nodeId}`).expect(200);
    expect(merged.body.userData).toEqual({ note: 9, comment: 'Relu' });

    await a.patch(`/v1/nodes/${nodeId}`).send({ note: 11 }).expect(400);
  });

  it('userData.status : PATCH, relecture, merge partiel preserve, valeur inconnue rejetee', async () => {
    const a = h.as(USER_A);
    const coll = await collection(USER_A, 'vinyl', 'statuts');
    const created = await a
      .post(`/v1/collections/${coll}/items`)
      .send({ unifiedData: { title: 'Wanted' } })
      .expect(201);
    const itemId = created.body.id as string;
    expect(created.body.userData.status).toBeUndefined();

    await a.patch(`/v1/items/${itemId}`).send({ userData: { status: 'WISHLIST' } }).expect(200);
    const detail = await a.get(`/v1/items/${itemId}`).expect(200);
    expect(detail.body.userData.status).toBe('WISHLIST');
    const list = await a.get(`/v1/collections/${coll}/items`).expect(200);
    expect(list.body.data[0].status).toBe('WISHLIST');

    const patched = await a
      .patch(`/v1/items/${itemId}`)
      .send({ userData: { rating: 4 } })
      .expect(200);
    expect(patched.body.userData).toMatchObject({ status: 'WISHLIST', rating: 4 });

    await a.patch(`/v1/items/${itemId}`).send({ userData: { status: 'FOO' } }).expect(400);
  });

  it('userData.playCount : PATCH, relecture, merge partiel preserve, negatif et decimal rejetes', async () => {
    const a = h.as(USER_A);
    const coll = await collection(USER_A, 'vinyl', 'ecoutes');
    const created = await a
      .post(`/v1/collections/${coll}/items`)
      .send({ unifiedData: { title: 'Degiheugi - Endless Smile' } })
      .expect(201);
    const itemId = created.body.id as string;
    expect(created.body.userData.playCount).toBeUndefined();

    await a.patch(`/v1/items/${itemId}`).send({ userData: { playCount: 12 } }).expect(200);
    expect((await a.get(`/v1/items/${itemId}`).expect(200)).body.userData.playCount).toBe(12);
    const list = await a.get(`/v1/collections/${coll}/items`).expect(200);
    expect(list.body.data[0].playCount).toBe(12);

    const patched = await a
      .patch(`/v1/items/${itemId}`)
      .send({ userData: { lastPlayedAt: '2026-08-24T20:00:00.000Z' } })
      .expect(200);
    expect(patched.body.userData).toMatchObject({
      playCount: 12,
      lastPlayedAt: '2026-08-24T20:00:00.000Z',
    });
    for (const playCount of [-1, 1.5]) {
      await a.patch(`/v1/items/${itemId}`).send({ userData: { playCount } }).expect(400);
    }
  });

  it('ecritures d un autre compte : 404 sur la collection, l item et le noeud de A', async () => {
    const coll = await collection(USER_A, 'manga', 'A mangas');
    const tome = await h
      .as(USER_A)
      .post(`/v1/collections/${coll}/items`)
      .send({ node: { provider: 'mal', externalId: '99' }, volume: 1, unifiedData: {} })
      .expect(201);
    const b = h.as(USER_B);
    await b
      .post(`/v1/collections/${coll}/items`)
      .send({ node: { provider: 'mal', externalId: '99' }, volume: 2, unifiedData: {} })
      .expect(404);
    await b
      .patch(`/v1/items/${tome.body.id}`)
      .send({ unifiedData: { title: 'vol' } })
      .expect(404);
    await b.delete(`/v1/items/${tome.body.id}`).expect(404);
    await b.patch(`/v1/nodes/${tome.body.nodeId}`).send({ note: 1 }).expect(404);
    await b
      .post(`/v1/collections/${coll}/nodes`)
      .send({ level: 'serie', unifiedData: { title: 'intrus' } })
      .expect(404);
    expect(await h.db.item.count()).toBe(1);
    expect(await h.db.collectionNode.count()).toBe(1);
  });

  it('lectures d un autre compte sans partage : 404 partout, comme une ressource inexistante', async () => {
    const coll = await collection(USER_A, 'manga', 'A mangas');
    const tome = await h
      .as(USER_A)
      .post(`/v1/collections/${coll}/items`)
      .send({ node: { provider: 'mal', externalId: '99' }, volume: 1, unifiedData: {} })
      .expect(201);
    const b = h.as(USER_B);
    for (const url of [
      `/v1/collections/${coll}`,
      `/v1/collections/${coll}/items`,
      `/v1/collections/${coll}/nodes`,
      `/v1/items/${tome.body.id}`,
      `/v1/items/${tome.body.id}/sources`,
      `/v1/nodes/${tome.body.nodeId}`,
      `/v1/nodes/${tome.body.nodeId}/sources`,
    ]) {
      const res: Response = await b.get(url);
      expect({ url, status: res.status }).toEqual({ url, status: 404 });
    }
  });

  it('type sans profil (movie) : POST permissif', async () => {
    const coll = await collection(USER_A, 'movie', 'films');
    const created = await h
      .as(USER_A)
      .post(`/v1/collections/${coll}/items`)
      .send({ unifiedData: { whatever: 'goes', nested: { ok: true } } })
      .expect(201);
    expect(created.body.unifiedData).toMatchObject({ whatever: 'goes' });
  });

  it('un noeud ne compte pas comme un item : itemCount ne bouge qu au tome', async () => {
    const a = h.as(USER_A);
    const coll = await collection(USER_A, 'manga', 'q');
    await a
      .post(`/v1/collections/${coll}/nodes`)
      .send({ level: 'serie', source: { provider: 'mal', externalId: '7' } })
      .expect(201);
    expect((await a.get(`/v1/collections/${coll}`).expect(200)).body.itemCount).toBe(0);
    await a
      .post(`/v1/collections/${coll}/items`)
      .send({ node: { provider: 'mal', externalId: '7' }, volume: 1, unifiedData: {} })
      .expect(201);
    expect((await a.get(`/v1/collections/${coll}`).expect(200)).body.itemCount).toBe(1);
  });

  // Le monolithe rendait 400 ici, et l'app recoit toujours 400 : c'est le gateway qui refuse
  // un identifiant malforme avant de router (principal.service.ts, teste dans le gateway). Le
  // catalog seul rend 404, parce que son garde d'acces cherche la ressource avant que le
  // parametre ne soit valide ; il ne voit jamais un tel identifiant en production.
  it('un identifiant malforme, vu du catalog seul : 404 (le gateway rend 400 en amont)', async () => {
    await h.as(USER_A).get('/v1/items/pas-un-uuid').expect(404);
    await h.as(USER_A).get('/v1/collections/pas-un-uuid').expect(404);
  });

  describe('creation de serie (equivalent de nodes.service.spec du monolithe)', () => {
    it('une source sans adapter est acceptee quand le unifiedData decrit la serie', async () => {
      const coll = await collection(USER_A, 'manga');
      const res = await h
        .as(USER_A)
        .post(`/v1/collections/${coll}/nodes`)
        .send({
          level: 'serie',
          source: { provider: 'mangadex', externalId: 'abc' },
          unifiedData: { title: 'Vinland Saga' },
        })
        .expect(201);
      expect(res.body.title).toBe('Vinland Saga');
      expect(res.body.sources).toEqual([
        { provider: 'mangadex', externalId: 'abc', fetchedAt: null },
      ]);
    });

    it('une source sans adapter ni unifiedData est refusee : rien ne decrit le noeud', async () => {
      const coll = await collection(USER_A, 'manga');
      await h
        .as(USER_A)
        .post(`/v1/collections/${coll}/nodes`)
        .send({ level: 'serie', source: { provider: 'mangadex', externalId: 'abc' } })
        .expect(400);
      expect(await h.db.collectionNode.count()).toBe(0);
    });

    it('unifiedData invalide : 400 de validation, pas une 500', async () => {
      const coll = await collection(USER_A, 'manga');
      await h
        .as(USER_A)
        .post(`/v1/collections/${coll}/nodes`)
        .send({ level: 'serie', unifiedData: { title: '' } })
        .expect(400);
    });

    it('le unifiedData du client l emporte sur le snapshot provider', async () => {
      const coll = await collection(USER_A, 'manga');
      const res = await h
        .as(USER_A)
        .post(`/v1/collections/${coll}/nodes`)
        .send({
          level: 'serie',
          source: { provider: 'mal', externalId: '9' },
          unifiedData: { title: 'Vinland Saga' },
        })
        .expect(201);
      expect(res.body.title).toBe('Vinland Saga');
      expect(res.body.sources[0]).toMatchObject({ provider: 'mal', fetchedAt: SNAPSHOT_FETCHED_AT });
    });

    it('meme source deja rattachee : le noeud existant est rendu, pas de doublon', async () => {
      const coll = await collection(USER_A, 'manga');
      const body = { level: 'serie', source: { provider: 'mal', externalId: '9' } };
      const first = await h.as(USER_A).post(`/v1/collections/${coll}/nodes`).send(body).expect(201);
      const again = await h.as(USER_A).post(`/v1/collections/${coll}/nodes`).send(body);
      expect([200, 201]).toContain(again.status);
      expect(again.body.id).toBe(first.body.id);
      expect(await h.db.collectionNode.count()).toBe(1);
    });

    it('niveau inconnu pour ce type : 400 ; aucun niveau sur un type plat : 400', async () => {
      const manga = await collection(USER_A, 'manga');
      await h
        .as(USER_A)
        .post(`/v1/collections/${manga}/nodes`)
        .send({ level: 'saison', unifiedData: { title: 'x' } })
        .expect(400);
      const lego = await collection(USER_A, 'lego');
      await h
        .as(USER_A)
        .post(`/v1/collections/${lego}/nodes`)
        .send({ level: 'serie', unifiedData: { title: 'x' } })
        .expect(400);
    });
  });

  it('search injoignable : la source est gardee sans enrichissement, l ecriture reussit', async () => {
    const coll = await collection(USER_A, 'manga');
    h.transport.searchDown = true;
    const created = await h
      .as(USER_A)
      .post(`/v1/collections/${coll}/nodes`)
      .send({
        level: 'serie',
        source: { provider: 'mal', externalId: '5' },
        unifiedData: { title: 'Saisie de secours' },
      })
      .expect(201);
    expect(created.body).toMatchObject({ title: 'Saisie de secours' });
    expect(created.body.sources).toEqual([
      { provider: 'mal', externalId: '5', fetchedAt: null },
    ]);
  });
});
