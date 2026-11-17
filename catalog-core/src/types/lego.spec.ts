import { LegoItemSchema, legoProfile } from './lego';

/*
 * Profil `lego`. Comme les autres tests de `catalog-core`, ce fichier ne tourne pas seul : il
 * tourne dans chaque catalog (`roots` de leur configuration Jest), contre son client Prisma.
 */
const ROW = {
  id: '6c1f8a8e-2f7b-4c55-9d3e-0f7f5e2b9a10',
  nodeId: null,
  volume: null,
  node: null,
};

describe('profil lego', () => {
  it('accepte une boite complete', () => {
    const parsed = LegoItemSchema.parse({
      type: 'lego',
      title: 'Bulldozer D11',
      setNumber: '42131',
      year: 2021,
      theme: 'Technic',
      themeId: 1,
      numParts: 3854,
      minifigs: 0,
      coverUrl: 'https://cdn.rebrickable.com/media/sets/42131-1/97409.jpg',
    });
    expect(parsed).toMatchObject({ setNumber: '42131', numParts: 3854 });
  });

  it('defauts null quand absents, et une URL vide vaut null', () => {
    const parsed = LegoItemSchema.parse({
      type: 'lego',
      title: 'Set sans fiche',
      coverUrl: '',
    });
    expect(parsed).toEqual({
      type: 'lego',
      title: 'Set sans fiche',
      setNumber: null,
      year: null,
      theme: null,
      themeId: null,
      numParts: null,
      minifigs: null,
      coverUrl: null,
    });
  });

  it("refuse un champ hors schema : le code-barres et le numero canonique vont dans sources[]", () => {
    for (const extra of [{ barcode: '5702016914320' }, { setNum: '42131-1' }]) {
      expect(
        LegoItemSchema.safeParse({ type: 'lego', title: 'X', ...extra })
          .success,
      ).toBe(false);
    }
  });

  it('refuse un autre type, un titre vide et des comptes negatifs', () => {
    expect(
      LegoItemSchema.safeParse({ type: 'vinyl', title: 'X' }).success,
    ).toBe(false);
    expect(LegoItemSchema.safeParse({ type: 'lego', title: '' }).success).toBe(
      false,
    );
    expect(
      LegoItemSchema.safeParse({ type: 'lego', title: 'X', numParts: -1 })
        .success,
    ).toBe(false);
    expect(
      LegoItemSchema.safeParse({
        type: 'lego',
        title: 'X',
        setNumber: 'x'.repeat(33),
      }).success,
    ).toBe(false);
  });

  it('type plat, sans hierarchie', () => {
    expect(legoProfile.code).toBe('lego');
    expect(legoProfile.hierarchy).toEqual([]);
  });

  it('projection de liste : numero, annee, theme, image, statut - et pas de playCount', () => {
    const light = legoProfile.toListProjection({
      ...ROW,
      unifiedData: {
        type: 'lego',
        title: 'Bulldozer D11',
        setNumber: '42131',
        year: 2021,
        theme: 'Technic',
        numParts: 3854,
        coverUrl: null,
      },
      userData: { status: 'WISHLIST', playCount: 4, note: 'prive' },
    });
    expect(light).toEqual({
      id: ROW.id,
      type: 'lego',
      title: 'Bulldozer D11',
      setNumber: '42131',
      year: 2021,
      theme: 'Technic',
      coverUrl: null,
      status: 'WISHLIST',
    });
  });

  it('statut absent : possede, comme pour les autres types', () => {
    const light = legoProfile.toListProjection({
      ...ROW,
      unifiedData: { type: 'lego', title: 'X' },
      userData: {},
    });
    expect(light).toMatchObject({ status: 'OWNED', setNumber: null });
  });
});
