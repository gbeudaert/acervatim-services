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
 * Les routes publiques de sharing (`/v1/shares`), contre une vraie base. Equivalent de
 * `sharing/sharing.e2e.spec.ts` du monolithe (scenarios repris un a un), et des cas de
 * `sharing/sharing.service.spec.ts` qui tiennent mieux contre une base qu'avec un Prisma
 * simule : idempotence, marquage plutot que suppression, garde de la derniere place.
 *
 * Ce qui a quitte sharing se teste ailleurs : le gate premium de `POST /v1/shares` (402) et
 * la limitation du redeem sont au gateway (`premium: 'requester'` et le bucket 5/min de sa
 * table de routage) ; la lecture d'une collection partagee est au catalog
 * (catalog-core/test/shared-read.int-spec.ts). Ici, les principaux sont signes sans premium :
 * aucune route de sharing ne doit le regarder.
 */

const CODE = /^[A-Za-z0-9_-]{24}$/;

describe('partages (integration)', () => {
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
    body: Record<string, unknown>,
  ): Promise<{ id: string; code: string }> => {
    const res: Response = await h
      .as(owner)
      .post('/v1/shares')
      .send(body)
      .expect(201);
    return { id: res.body.id as string, code: res.body.code as string };
  };

  const redeem = (userId: string, code: string, label?: string) =>
    h
      .as(userId)
      .post('/v1/shares/redeem')
      .send(label === undefined ? { code } : { code, label });

  it('cycle complet : creer, rejoindre en compte gratuit, lister, revoquer', async () => {
    const coll = h.neighbours.addCollection(
      USER_A,
      'vinyl',
      'Vinyles du salon',
      {
        OWNED: 3,
        WISHLIST: 2,
      },
    );

    // 1. Le code sort une seule fois, et seul son HMAC est stocke.
    const created: Response = await h
      .as(USER_A)
      .post('/v1/shares')
      .send({
        collections: [{ collectionId: coll, statuses: ['OWNED'] }],
        maxUses: 2,
      })
      .expect(201);
    const shareId = created.body.id as string;
    const code = created.body.code as string;
    expect(code).toMatch(CODE);
    expect(created.body).not.toHaveProperty('codeHash');
    expect(created.body.collections).toEqual([
      {
        collectionId: coll,
        name: 'Vinyles du salon',
        type: 'vinyl',
        statuses: ['OWNED'],
      },
    ]);
    const row = await h.db.collectionShare.findUniqueOrThrow({
      where: { id: shareId },
    });
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(code);

    // 2. Une relecture ne redonne jamais le code.
    const listed: Response = await h.as(USER_A).get('/v1/shares').expect(200);
    expect(listed.body).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(code);
    expect(listed.body[0].members).toEqual([]);

    // 3. Le proprietaire ne rejoint pas son propre partage : 400 explicite.
    await redeem(USER_A, code).expect(400);

    // 4. Un compte gratuit rejoint ; le compte vient du catalog, sous les statuts du partage.
    const redeemed: Response = await redeem(USER_B, code).expect(200);
    expect(redeemed.body).toMatchObject({
      shareId,
      alreadyMember: false,
      collections: [
        {
          collectionId: coll,
          name: 'Vinyles du salon',
          type: 'vinyl',
          statuses: ['OWNED'],
          itemCount: 3,
        },
      ],
    });

    // 5. Idempotence : re-rejoindre ne consomme pas de place.
    const again: Response = await redeem(USER_B, code).expect(200);
    expect(again.body.alreadyMember).toBe(true);

    // 6. Le membre apparait cote proprietaire, et le partage dans ses recus.
    const afterRedeem: Response = await h
      .as(USER_A)
      .get('/v1/shares')
      .expect(200);
    expect(afterRedeem.body[0].usedCount).toBe(1);
    expect(afterRedeem.body[0].members).toEqual([
      expect.objectContaining({ memberUserId: USER_B }),
    ]);
    const received: Response = await h
      .as(USER_B)
      .get('/v1/shares/received')
      .expect(200);
    expect(received.body).toEqual([
      expect.objectContaining({
        shareId,
        collections: [
          expect.objectContaining({ collectionId: coll, itemCount: 3 }),
        ],
      }),
    ]);

    // 7. Revoquer, deux fois : la seconde ne change rien.
    await h.as(USER_A).delete(`/v1/shares/${shareId}`).expect(204);
    await h.as(USER_A).delete(`/v1/shares/${shareId}`).expect(204);

    // 8. Le code ne prend plus, et sans dire pourquoi : meme reponse qu'un code jamais emis.
    const refused: Response = await redeem(USER_C, code).expect(404);
    expect(refused.body.type).toContain('share-code-invalid');
    const unknown: Response = await redeem(USER_C, 'a'.repeat(24)).expect(404);
    expect(unknown.body.type).toBe(refused.body.type);
    expect(unknown.body.detail).toBe(refused.body.detail);

    // 9. Le membre perd le partage ; le proprietaire ne le voit plus dans sa liste.
    await h.as(USER_B).get('/v1/shares/received').expect(200, []);
    await h.as(USER_A).get('/v1/shares').expect(200, []);

    // 10. Marquage, pas suppression : la trace survit a la revocation.
    const kept = await h.db.collectionShare.findUniqueOrThrow({
      where: { id: shareId },
      include: { members: true, entries: true },
    });
    expect(kept.revokedAt).not.toBeNull();
    expect(kept.entries).toHaveLength(1);
    expect(kept.members).toEqual([
      expect.objectContaining({
        memberUserId: USER_B,
        revokedAt: expect.any(Date),
      }),
    ]);

    // 11. L'audit : une creation (taille seule), une adhesion, UNE revocation, aucun code.
    expect(h.neighbours.audits).toEqual([
      {
        userId: USER_A,
        action: 'share.create',
        target: shareId,
        metadata: { collections: 1 },
      },
      { userId: USER_B, action: 'share.redeem', target: shareId },
      { userId: USER_A, action: 'share.revoke', target: shareId },
    ]);
    expect(JSON.stringify(h.neighbours.audits)).not.toContain(code);
  });

  it('un seul code porte plusieurs collections, chacune avec ses statuts, triees par nom', async () => {
    const mangas = h.neighbours.addCollection(USER_A, 'manga', 'Mangas', {
      OWNED: 10,
      WISHLIST: 4,
    });
    const vinyles = h.neighbours.addCollection(USER_A, 'vinyl', 'Vinyles', {
      OWNED: 1,
      WISHLIST: 2,
      IGNORED: 5,
    });
    const grenier = h.neighbours.addCollection(
      USER_A,
      'vinyl',
      'Vinyles du grenier',
      {
        IGNORED: 7,
      },
    );
    const secrets = h.neighbours.addCollection(USER_A, 'vinyl', 'Pas partagee');

    const created: Response = await h
      .as(USER_A)
      .post('/v1/shares')
      .send({
        label: 'Wantlist manga avec Alice',
        // Ordre d'envoi volontairement different de l'ordre des noms, statuts dans le desordre.
        collections: [
          { collectionId: vinyles, statuses: ['WISHLIST', 'OWNED'] },
          { collectionId: grenier, statuses: ['IGNORED'] },
          { collectionId: mangas, statuses: ['WISHLIST'] },
        ],
      })
      .expect(201);
    expect(created.body.collections).toEqual([
      expect.objectContaining({
        collectionId: mangas,
        name: 'Mangas',
        statuses: ['WISHLIST'],
      }),
      expect.objectContaining({
        collectionId: vinyles,
        name: 'Vinyles',
        statuses: ['OWNED', 'WISHLIST'],
      }),
      expect.objectContaining({ collectionId: grenier, statuses: ['IGNORED'] }),
    ]);

    h.neighbours.calls.length = 0;
    const received: Response = await redeem(
      USER_B,
      created.body.code as string,
    ).expect(200);
    expect(
      (
        received.body.collections as {
          collectionId: string;
          itemCount: number;
        }[]
      ).map((c) => [c.collectionId, c.itemCount]),
    ).toEqual([
      [mangas, 4],
      [vinyles, 3],
      [grenier, 7],
    ]);
    // Un appel de comptage par catalog concerne, jamais un par entree.
    expect(
      h.neighbours
        .countCalls()
        .map((c) => c.baseUrl)
        .sort(),
    ).toEqual(['http://catalog-manga.test', 'http://catalog-vinyl.test']);

    // Le filtre par collection ne rend que les partages qui l'exposent.
    const onMangas: Response = await h
      .as(USER_A)
      .get(`/v1/shares?collectionId=${mangas}`)
      .expect(200);
    expect(onMangas.body).toHaveLength(1);
    await h
      .as(USER_A)
      .get(`/v1/shares?collectionId=${secrets}`)
      .expect(200, []);
  });

  it('chacun nomme le partage pour soi, et ne voit jamais le nom de l autre', async () => {
    const coll = h.neighbours.addCollection(USER_A, 'vinyl', 'Vinyles');
    const created: Response = await h
      .as(USER_A)
      .post('/v1/shares')
      .send({
        label: 'Wantlist manga avec Alice',
        collections: [{ collectionId: coll, statuses: ['WISHLIST'] }],
      })
      .expect(201);
    const shareId = created.body.id as string;
    expect(created.body.label).toBe('Wantlist manga avec Alice');

    const redeemed: Response = await redeem(
      USER_B,
      created.body.code as string,
      'Wantlist manga de Bob',
    ).expect(200);
    expect(redeemed.body.label).toBe('Wantlist manga de Bob');
    expect(JSON.stringify(redeemed.body)).not.toContain('Alice');

    const received: Response = await h
      .as(USER_B)
      .get('/v1/shares/received')
      .expect(200);
    expect(received.body[0].label).toBe('Wantlist manga de Bob');
    expect(JSON.stringify(received.body)).not.toContain('Alice');

    const listed: Response = await h.as(USER_A).get('/v1/shares').expect(200);
    expect(listed.body[0].label).toBe('Wantlist manga avec Alice');
    expect(JSON.stringify(listed.body)).not.toContain('Bob');

    // Chacun renomme le sien ; un membre deja actif qui re-rejoint avec un libelle l'applique.
    const renamedOwner: Response = await h
      .as(USER_A)
      .patch(`/v1/shares/${shareId}`)
      .send({ label: 'Wantlist manga avec Alice et Charlie' })
      .expect(200);
    expect(renamedOwner.body.label).toBe(
      'Wantlist manga avec Alice et Charlie',
    );
    expect(renamedOwner.body.collections).toHaveLength(1);
    const renamedMember: Response = await h
      .as(USER_B)
      .patch(`/v1/shares/received/${shareId}`)
      .send({ label: 'Full collection Charlie' })
      .expect(200);
    expect(renamedMember.body.label).toBe('Full collection Charlie');
    const relabel: Response = await redeem(
      USER_B,
      created.body.code as string,
      'Chez Alice',
    ).expect(200);
    expect(relabel.body).toMatchObject({
      alreadyMember: true,
      label: 'Chez Alice',
    });

    // Un libelle vide efface au lieu de stocker une chaine vide.
    const cleared: Response = await h
      .as(USER_A)
      .patch(`/v1/shares/${shareId}`)
      .send({ label: '   ' })
      .expect(200);
    expect(cleared.body.label).toBeNull();
    expect(
      (await h.db.collectionShare.findUniqueOrThrow({ where: { id: shareId } }))
        .label,
    ).toBeNull();

    // Les libelles nomment des gens : ils ne vont pas dans l'audit.
    const audit = JSON.stringify(h.neighbours.audits);
    expect(audit).not.toContain('Alice');
    expect(audit).not.toContain('Bob');
  });

  it('autant de partages qu on veut de la meme collection', async () => {
    const coll = h.neighbours.addCollection(USER_A, 'vinyl', 'Vinyles');
    for (let i = 0; i < 5; i++) {
      await share(USER_A, {
        label: `Partage ${i}`,
        collections: [{ collectionId: coll, statuses: ['OWNED'] }],
      });
    }
    const listed: Response = await h.as(USER_A).get('/v1/shares').expect(200);
    expect(listed.body).toHaveLength(5);
  });

  it('refuse un partage mal forme', async () => {
    const coll = h.neighbours.addCollection(USER_A, 'vinyl', 'Vinyles');
    const bad: unknown[] = [
      // Collection en double.
      {
        collections: [
          { collectionId: coll, statuses: ['OWNED'] },
          { collectionId: coll, statuses: ['WISHLIST'] },
        ],
      },
      { collections: [{ collectionId: coll, statuses: [] }] },
      { collections: [] },
      // Les portees de S4 ne sont plus un vocabulaire du serveur.
      { collections: [{ collectionId: coll, statuses: ['wantlist'] }] },
      { collections: [{ collectionId: 'pas-un-uuid', statuses: ['OWNED'] }] },
      {
        collections: [{ collectionId: coll, statuses: ['OWNED'] }],
        maxUses: 0,
      },
      {
        collections: [{ collectionId: coll, statuses: ['OWNED'] }],
        maxUses: 101,
      },
      {
        collections: [{ collectionId: coll, statuses: ['OWNED'] }],
        scope: 'all',
      },
    ];
    for (const body of bad) {
      const res: Response = await h
        .as(USER_A)
        .post('/v1/shares')
        .send(body as object);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    expect(await h.db.collectionShare.count()).toBe(0);
  });

  it('la collection ou le partage d autrui reste un 404, sans dire laquelle', async () => {
    const mine = h.neighbours.addCollection(USER_B, 'vinyl', 'A moi');
    const theirs = h.neighbours.addCollection(USER_A, 'manga', 'A Alice');

    await h
      .as(USER_B)
      .post('/v1/shares')
      .send({ collections: [{ collectionId: theirs, statuses: ['OWNED'] }] })
      .expect(404);
    // Une seule collection d'autrui parmi les siennes suffit, et rien n'est cree.
    await h
      .as(USER_B)
      .post('/v1/shares')
      .send({
        collections: [
          { collectionId: mine, statuses: ['OWNED'] },
          { collectionId: theirs, statuses: ['OWNED'] },
        ],
      })
      .expect(404);
    // Une collection qu'aucun catalog ne connait : meme reponse.
    await h
      .as(USER_B)
      .post('/v1/shares')
      .send({
        collections: [
          {
            collectionId: '11111111-1111-4111-8111-111111111111',
            statuses: ['OWNED'],
          },
        ],
      })
      .expect(404);
    expect(await h.db.collectionShare.count()).toBe(0);
    await h.as(USER_B).get(`/v1/shares?collectionId=${theirs}`).expect(404);

    // Le partage d'autrui : ni renommable, ni revocable, ni ses membres.
    const alice = await share(USER_A, {
      collections: [{ collectionId: theirs, statuses: ['OWNED'] }],
    });
    await redeem(USER_C, alice.code).expect(200);
    await h
      .as(USER_B)
      .patch(`/v1/shares/${alice.id}`)
      .send({ label: 'x' })
      .expect(404);
    await h.as(USER_B).delete(`/v1/shares/${alice.id}`).expect(404);
    await h
      .as(USER_B)
      .delete(`/v1/shares/${alice.id}/members/${USER_C}`)
      .expect(404);
    await h
      .as(USER_B)
      .patch(`/v1/shares/received/${alice.id}`)
      .send({ label: 'x' })
      .expect(404);
    const kept = await h.db.collectionShare.findUniqueOrThrow({
      where: { id: alice.id },
      include: { members: true },
    });
    expect(kept).toMatchObject({ revokedAt: null, label: null });
    expect(kept.members[0].revokedAt).toBeNull();
  });

  it('un membre ejecte ne revient pas avec le meme code, les autres restent', async () => {
    const coll = h.neighbours.addCollection(USER_A, 'vinyl', 'Vinyles');
    const { id: shareId, code } = await share(USER_A, {
      collections: [{ collectionId: coll, statuses: ['WISHLIST'] }],
      maxUses: 5,
    });
    await redeem(USER_B, code).expect(200);
    await redeem(USER_C, code).expect(200);

    await h
      .as(USER_A)
      .delete(`/v1/shares/${shareId}/members/${USER_B}`)
      .expect(204);
    // Idempotent : ejecter deux fois n'audite qu'une fois.
    await h
      .as(USER_A)
      .delete(`/v1/shares/${shareId}/members/${USER_B}`)
      .expect(204);
    // Un compte qui n'a jamais rejoint : 404.
    await h
      .as(USER_A)
      .delete(`/v1/shares/${shareId}/members/${USER_D}`)
      .expect(404);

    const back: Response = await redeem(USER_B, code).expect(404);
    expect(back.body.type).toContain('share-code-invalid');

    const listed: Response = await h.as(USER_A).get('/v1/shares').expect(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].members).toEqual([
      expect.objectContaining({ memberUserId: USER_C }),
    ]);
    // La place consommee par l'ejecte n'est pas rendue.
    expect(listed.body[0].usedCount).toBe(2);

    await h.as(USER_B).get('/v1/shares/received').expect(200, []);
    const other: Response = await h
      .as(USER_C)
      .get('/v1/shares/received')
      .expect(200);
    expect(other.body).toHaveLength(1);
    await h
      .as(USER_B)
      .patch(`/v1/shares/received/${shareId}`)
      .send({ label: 'toujours la ?' })
      .expect(404);

    expect(
      h.neighbours.audits.filter((a) => a.action === 'share.member.revoke'),
    ).toEqual([
      { userId: USER_A, action: 'share.member.revoke', target: shareId },
    ]);
  });

  it('le code tombe a court de places ou expire : meme refus, sans oracle', async () => {
    const coll = h.neighbours.addCollection(USER_A, 'vinyl', 'Vinyles');
    const single = await share(USER_A, {
      collections: [{ collectionId: coll, statuses: ['OWNED'] }],
      maxUses: 1,
    });
    await redeem(USER_B, single.code).expect(200);
    const full: Response = await redeem(USER_C, single.code).expect(404);
    expect(full.body.type).toContain('share-code-invalid');

    const expired = await share(USER_A, {
      collections: [{ collectionId: coll, statuses: ['OWNED'] }],
      expiresAt: Date.now() - 1000,
    });
    const late: Response = await redeem(USER_B, expired.code).expect(404);
    expect(late.body).toMatchObject({
      type: full.body.type,
      detail: full.body.detail,
    });

    // Un partage expire reste liste : le proprietaire doit voir pourquoi son code ne prend plus.
    const listed: Response = await h.as(USER_A).get('/v1/shares').expect(200);
    expect(listed.body.map((s: { id: string }) => s.id).sort()).toEqual(
      [single.id, expired.id].sort(),
    );
  });

  it('la derniere place ne se donne qu une fois, meme a des redeems simultanes', async () => {
    const coll = h.neighbours.addCollection(USER_A, 'vinyl', 'Vinyles');
    const { id, code } = await share(USER_A, {
      collections: [{ collectionId: coll, statuses: ['OWNED'] }],
      maxUses: 2,
    });
    const results = await Promise.all(
      [USER_B, USER_C, USER_D, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'].map(
        (u) => redeem(u, code).then((r: Response) => r.status),
      ),
    );
    expect(results.filter((s) => s === 200)).toHaveLength(2);
    expect(results.filter((s) => s === 404)).toHaveLength(2);
    const row = await h.db.collectionShare.findUniqueOrThrow({
      where: { id },
      include: { members: true },
    });
    expect(row.usedCount).toBe(2);
    expect(row.members).toHaveLength(2);
  });

  it('cote membre : le nom courant du catalog l emporte, et un catalog en panne donne null, pas 0', async () => {
    const coll = h.neighbours.addCollection(USER_A, 'manga', 'Mangas', {
      OWNED: 2,
    });
    const { code } = await share(USER_A, {
      collections: [{ collectionId: coll, statuses: ['OWNED'] }],
    });
    await redeem(USER_B, code).expect(200);

    h.neighbours.rename(coll, 'Mangas du salon');
    const fresh: Response = await h
      .as(USER_B)
      .get('/v1/shares/received')
      .expect(200);
    expect(fresh.body[0].collections[0]).toMatchObject({
      name: 'Mangas du salon',
      itemCount: 2,
    });
    // Le proprietaire lit la copie denormalisee, sans appeler les catalogs : elle a vieilli.
    h.neighbours.calls.length = 0;
    const owner: Response = await h.as(USER_A).get('/v1/shares').expect(200);
    expect(owner.body[0].collections[0].name).toBe('Mangas');
    expect(h.neighbours.calls).toEqual([]);

    h.neighbours.countsDown = true;
    const down: Response = await h
      .as(USER_B)
      .get('/v1/shares/received')
      .expect(200);
    expect(down.body[0].collections[0]).toMatchObject({
      collectionId: coll,
      name: 'Mangas',
      itemCount: null,
    });
  });

  it('sans principal valide : 401, et un identifiant malforme reste un 400', async () => {
    await h.raw().get('/v1/shares').expect(401);
    await h
      .raw()
      .get('/v1/shares')
      .set('x-acervatim-principal', 'forge.forge')
      .expect(401);
    await h.as(USER_A).delete('/v1/shares/pas-un-uuid').expect(400);
    await h
      .as(USER_A)
      .patch('/v1/shares/received/pas-un-uuid')
      .send({ label: 'x' })
      .expect(400);
  });
});
