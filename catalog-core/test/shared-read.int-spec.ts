import { createHarness, Harness, TestPrincipal, USER_A, USER_B } from './harness';

/*
 * Lecture d'une collection partagee, cote catalog, contre une vraie base. Equivalent de la
 * partie catalog de `sharing/shared-read.e2e.spec.ts` du monolithe : le filtrage par statut
 * (requetes SQL de `share-filter.service.ts`), les comptes recalcules et le masquage des
 * donnees privees.
 *
 * Ce qui a quitte le catalog n'est pas ici. Le gateway resout l'acces aupres de `sharing` et
 * signe le principal (`role: 'shared'`, `statuses`) ; c'est lui qui rend 403 a l'ecriture d'un
 * membre, 404 apres revocation ou ejection, et 402 quand le proprietaire perd son premium.
 *
 * Decor, comme dans le monolithe :
 *
 *   Serie A (mal:1) --+-- tome 1  OWNED     (prix, note libre, note 4)
 *                     +-- tome 2  WISHLIST
 *   Serie B (mal:2) ----- tome 1  IGNORED
 *   Serie C (mal:3)       aucun tome, en wishlist
 */
interface Decor {
  collectionId: string;
  owned1: string;
  wish2: string;
  ignored1: string;
  serieA: string;
  serieB: string;
  serieC: string;
}

describe('lecture partagee (integration)', () => {
  let h: Harness;
  let d: Decor;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await h.clean();
    const owner = h.as(USER_A);
    const coll = await owner
      .post('/v1/collections')
      .send({ typeCode: 'manga', name: 'Mangas du salon' })
      .expect(201);
    const collectionId = coll.body.id as string;
    const tome = async (
      serie: string,
      volume: number,
      status: string,
      extra: Record<string, unknown> = {},
    ) => {
      const res = await owner
        .post(`/v1/collections/${collectionId}/items`)
        .send({
          node: { provider: 'mal', externalId: serie },
          volume,
          unifiedData: { title: `Serie ${serie} T.${volume}` },
          userData: { status, ...extra },
        })
        .expect(201);
      return { id: res.body.id as string, nodeId: res.body.nodeId as string };
    };
    const t1 = await tome('1', 1, 'OWNED', {
      purchasePrice: 12.5,
      note: 'offert par mamie',
      rating: 4,
    });
    const t2 = await tome('1', 2, 'WISHLIST');
    const b1 = await tome('2', 1, 'IGNORED');
    const serieC = await owner
      .post(`/v1/collections/${collectionId}/nodes`)
      .send({
        level: 'serie',
        source: { provider: 'mal', externalId: '3' },
        isWishlist: true,
      })
      .expect(201);
    d = {
      collectionId,
      owned1: t1.id,
      wish2: t2.id,
      ignored1: b1.id,
      serieA: t1.nodeId,
      serieB: b1.nodeId,
      serieC: serieC.body.id as string,
    };
  });

  const member = (statuses: string[]): TestPrincipal => ({
    userId: USER_B,
    role: 'shared',
    statuses,
  });
  const itemIds = async (p: TestPrincipal | string) => {
    const res = await h
      .as(p)
      .get(`/v1/collections/${d.collectionId}/items`)
      .expect(200);
    return (res.body.data as { id: string }[]).map((i) => i.id).sort();
  };
  const nodeIds = async (p: TestPrincipal | string) => {
    const res = await h
      .as(p)
      .get(`/v1/collections/${d.collectionId}/nodes`)
      .expect(200);
    return (res.body.data as { id: string }[]).map((n) => n.id).sort();
  };

  describe('possedes seuls', () => {
    const p = member(['OWNED']);

    it('ne montre que les possedes, et rend un 404 - pas un 403 - sur le reste', async () => {
      expect(await itemIds(p)).toEqual([d.owned1]);
      await h.as(p).get(`/v1/items/${d.wish2}`).expect(404);
      await h.as(p).get(`/v1/items/${d.ignored1}`).expect(404);
      await h.as(p).get(`/v1/items/${d.wish2}/sources`).expect(404);
      expect(await nodeIds(p)).toEqual([d.serieA]);
      await h.as(p).get(`/v1/nodes/${d.serieC}`).expect(404);
      await h.as(p).get(`/v1/nodes/${d.serieB}`).expect(404);
    });

    it('recalcule itemCount et la hierarchie sous les statuts exposes', async () => {
      const res = await h
        .as(p)
        .get(`/v1/collections/${d.collectionId}`)
        .expect(200);
      expect(res.body.itemCount).toBe(1);
      expect(res.body.hierarchy).toEqual([
        { key: 'serie', label: 'Série', count: 1 },
      ]);
      // Le compte que `sharing` affiche dans « partages recus » vient de cette route.
      const counted = await h
        .raw()
        .post('/internal/items/count')
        .send({
          entries: [{ collectionId: d.collectionId, statuses: ['OWNED'] }],
        })
        .expect(201);
      expect(counted.body.counts).toEqual([
        { collectionId: d.collectionId, count: 1, name: 'Mangas du salon' },
      ]);
    });

    it('masque le prix d achat et la note libre du proprietaire', async () => {
      const mine = await h.as(USER_A).get(`/v1/items/${d.owned1}`).expect(200);
      expect(mine.body.userData).toMatchObject({
        purchasePrice: 12.5,
        note: 'offert par mamie',
      });
      const theirs = await h.as(p).get(`/v1/items/${d.owned1}`).expect(200);
      expect(theirs.body.userData).toEqual({ status: 'OWNED', rating: 4 });
      expect(theirs.body.unifiedData).toEqual(mine.body.unifiedData);
    });
  });

  describe('desires seuls', () => {
    const p = member(['WISHLIST']);

    it('ne montre que les desires, series desirees sans tome comprises', async () => {
      expect(await itemIds(p)).toEqual([d.wish2]);
      await h.as(p).get(`/v1/items/${d.owned1}`).expect(404);
      expect(await nodeIds(p)).toEqual([d.serieA, d.serieC].sort());
      const serieA = await h.as(p).get(`/v1/nodes/${d.serieA}`).expect(200);
      expect(serieA.body.ownedCount).toBe(1);
    });

    it('rend une liste vide quand rien n est desire, sans tout laisser passer', async () => {
      await h
        .as(USER_A)
        .patch(`/v1/items/${d.wish2}`)
        .send({ userData: { status: 'OWNED' } })
        .expect(200);
      expect(await itemIds(p)).toEqual([]);
      const res = await h
        .as(p)
        .get(`/v1/collections/${d.collectionId}`)
        .expect(200);
      expect(res.body.itemCount).toBe(0);
    });
  });

  describe('tous les statuts', () => {
    const p = member(['OWNED', 'WISHLIST', 'IGNORED']);

    it('montre tout, y compris les ignores', async () => {
      expect(await itemIds(p)).toEqual(
        [d.owned1, d.wish2, d.ignored1].sort(),
      );
      expect(await nodeIds(p)).toEqual([d.serieA, d.serieB, d.serieC].sort());
    });

    it('montre une serie vide non desiree, comme la liste du proprietaire', async () => {
      const empty = await h
        .as(USER_A)
        .post(`/v1/collections/${d.collectionId}/nodes`)
        .send({ level: 'serie', unifiedData: { title: 'Vide' } })
        .expect(201);
      expect(await nodeIds(p)).toContain(empty.body.id);
      await h.as(p).get(`/v1/nodes/${empty.body.id}`).expect(200);
    });

    it('masque quand meme le userData prive : le role decide, pas les statuts', async () => {
      const theirs = await h.as(p).get(`/v1/items/${d.owned1}`).expect(200);
      expect(theirs.body.userData).toEqual({ status: 'OWNED', rating: 4 });
      await h
        .as(USER_A)
        .patch(`/v1/nodes/${d.serieA}`)
        .send({ note: 8, comment: 'prive' })
        .expect(200);
      const node = await h.as(p).get(`/v1/nodes/${d.serieA}`).expect(200);
      expect(node.body.userData).toEqual({ note: 8 });
    });
  });

  it('ensemble de statuts vide : rien n est visible', async () => {
    const p = member([]);
    expect(await itemIds(p)).toEqual([]);
    await h.as(p).get(`/v1/items/${d.owned1}`).expect(404);
  });

  it('un statut absent ou inconnu en base compte comme OWNED (SQL et projection d accord)', async () => {
    await h.db.item.update({
      where: { id: d.wish2 },
      data: { userData: { rating: 2 } },
    });
    await h.db.item.update({
      where: { id: d.ignored1 },
      data: { userData: { status: 'FOO' } },
    });
    const p = member(['OWNED']);
    expect(await itemIds(p)).toEqual([d.owned1, d.wish2, d.ignored1].sort());
    const list = await h
      .as(USER_A)
      .get(`/v1/collections/${d.collectionId}/items`)
      .expect(200);
    expect(
      (list.body.data as { status: string }[]).every((i) => i.status === 'OWNED'),
    ).toBe(true);
  });

  it('les ecritures d un membre n atteignent pas les donnees (404 ici, 403 au gateway)', async () => {
    const p = member(['OWNED', 'WISHLIST', 'IGNORED']);
    const writes = [
      () => h.as(p).patch(`/v1/collections/${d.collectionId}`).send({ name: 'renommee' }),
      () => h.as(p).delete(`/v1/collections/${d.collectionId}`),
      () =>
        h
          .as(p)
          .post(`/v1/collections/${d.collectionId}/items`)
          .send({
            node: { provider: 'mal', externalId: '1' },
            volume: 9,
            unifiedData: { title: 'intrus' },
          }),
      () =>
        h
          .as(p)
          .post(`/v1/collections/${d.collectionId}/nodes`)
          .send({ level: 'serie', source: { provider: 'mal', externalId: '9' } }),
      () => h.as(p).patch(`/v1/items/${d.owned1}`).send({ userData: { status: 'IGNORED' } }),
      () => h.as(p).delete(`/v1/items/${d.owned1}`),
      () =>
        h
          .as(p)
          .post(`/v1/items/${d.owned1}/sources`)
          .send({ provider: 'isbn', externalId: '978' }),
      () => h.as(p).patch(`/v1/nodes/${d.serieA}`).send({ note: 10 }),
      () =>
        h
          .as(p)
          .post(`/v1/nodes/${d.serieA}/sources`)
          .send({ provider: 'isbn', externalId: '978' }),
    ];
    for (const write of writes) {
      const res = await write();
      expect([403, 404]).toContain(res.status);
    }
    expect(await h.db.item.count({ where: { collectionId: d.collectionId } })).toBe(3);
    expect(await h.db.collectionNode.count()).toBe(3);
    const coll = await h.db.collection.findUnique({ where: { id: d.collectionId } });
    expect(coll?.name).toBe('Mangas du salon');
    const owned = await h.db.item.findUnique({ where: { id: d.owned1 } });
    expect((owned?.userData as { status: string }).status).toBe('OWNED');
    expect(owned?.sources).toEqual([]);
  });

  it('les statuts ne se forcent pas depuis le client', async () => {
    const p = member(['OWNED']);
    await h
      .as(p)
      .get(`/v1/collections/${d.collectionId}/items?scope=all`)
      .expect(400);
    const res = await h
      .as(p)
      .get(`/v1/collections/${d.collectionId}/items`)
      .set('X-Share-Scope', 'all')
      .expect(200);
    expect((res.body.data as { id: string }[]).map((i) => i.id)).toEqual([d.owned1]);
  });

  it('le proprietaire voit 100 % de sa collection, quels que soient les partages emis', async () => {
    expect(await itemIds(USER_A)).toEqual([d.owned1, d.wish2, d.ignored1].sort());
    expect(await nodeIds(USER_A)).toHaveLength(3);
    const res = await h.as(USER_A).get(`/v1/collections/${d.collectionId}`).expect(200);
    expect(res.body.itemCount).toBe(3);
    const item = await h.as(USER_A).get(`/v1/items/${d.owned1}`).expect(200);
    expect(item.body.userData.purchasePrice).toBe(12.5);
  });
});
