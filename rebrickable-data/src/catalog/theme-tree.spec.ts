import {
  buildThemeTree,
  RawTheme,
  slugify,
  SLUG_MAX_LENGTH,
  ThemeIndex,
  uniqueSlug,
} from './theme-tree';

describe('slugify', () => {
  it('normalise un nom de theme simple', () => {
    expect(slugify('Technic')).toBe('technic');
    expect(slugify('Architecture')).toBe('architecture');
  });

  it('remplace les separateurs par un tiret unique', () => {
    expect(slugify('Star Wars')).toBe('star-wars');
    expect(slugify('Ninjago / Legacy')).toBe('ninjago-legacy');
    expect(slugify('4 Juniors')).toBe('4-juniors');
  });

  it('aplatit les diacritiques', () => {
    expect(slugify('Belville Fée')).toBe('belville-fee');
  });

  it('ne laisse ni tiret de tete ni tiret de queue', () => {
    expect(slugify('  Duplo  ')).toBe('duplo');
    expect(slugify('-Creator-')).toBe('creator');
  });

  it('rend une chaine vide quand il ne reste rien d alphanumerique', () => {
    expect(slugify('///')).toBe('');
  });
});

/** Extrait reel de `themes.csv` : "Technic" existe a la racine et sous d'autres parents. */
const RAW: RawTheme[] = [
  { id: 497, name: 'Books', parentId: null },
  { id: 1, name: 'Technic', parentId: null },
  { id: 3, name: 'Competition', parentId: 1 },
  { id: 4, name: 'Expert Builder', parentId: 1 },
  { id: 5, name: 'Model', parentId: 1 },
  { id: 6, name: 'Airport', parentId: 5 },
  { id: 498, name: 'Technic', parentId: 497 },
];

describe('buildThemeTree', () => {
  const nodes = buildThemeTree(RAW);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  it('calcule le chemin depuis la racine et la profondeur', () => {
    expect(byId.get(1)).toMatchObject({ path: 'Technic', depth: 0 });
    expect(byId.get(6)).toMatchObject({
      path: 'Technic / Model / Airport',
      depth: 2,
      parentId: 5,
    });
    expect(byId.get(498)).toMatchObject({ path: 'Books / Technic', depth: 1 });
  });

  it('laisse le slug nu au premier id d un nom, suffixe les suivants', () => {
    expect(byId.get(1)!.slug).toBe('technic');
    expect(byId.get(498)!.slug).toBe('technic-498');
  });

  it('attribue les slugs par id croissant, quel que soit l ordre du CSV', () => {
    const reversed = buildThemeTree([...RAW].reverse());
    expect(reversed.find((n) => n.id === 1)!.slug).toBe('technic');
  });

  it('ne produit jamais deux fois le meme slug', () => {
    const tricky = buildThemeTree([
      { id: 1, name: 'Technic', parentId: null },
      { id: 2, name: 'Technic 3', parentId: null },
      { id: 3, name: 'Technic', parentId: null },
    ]);
    const slugs = tricky.map((n) => n.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('ne boucle pas sur une reference circulaire', () => {
    const cyclic = buildThemeTree([
      { id: 1, name: 'A', parentId: 2 },
      { id: 2, name: 'B', parentId: 1 },
    ]);
    expect(cyclic.find((n) => n.id === 1)).toMatchObject({
      path: 'B / A',
      depth: 1,
    });
  });

  it('borne le chemin a dix ancetres et a 512 caracteres', () => {
    const long = 'x'.repeat(100);
    const chain: RawTheme[] = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      name: `${long}${i}`,
      parentId: i === 0 ? null : i,
    }));
    const leaf = buildThemeTree(chain).find((n) => n.id === 15)!;
    expect(leaf.depth).toBe(10);
    expect(leaf.path.length).toBeLessThanOrEqual(512);
  });

  it('dedoublonne un id repete : la derniere ligne gagne, sans slug suffixe', () => {
    const nodes = buildThemeTree([
      { id: 1, name: 'Technic', parentId: null },
      { id: 1, name: 'Technic Renomme', parentId: null },
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      name: 'Technic Renomme',
      slug: 'technic-renomme',
    });
  });

  it('tient dans 255 caracteres meme suffixe : la base est tronquee avant le suffixe', () => {
    const name = 'a'.repeat(255);
    const nodes = buildThemeTree([
      { id: 1, name, parentId: null },
      { id: 123456, name, parentId: null },
      { id: 999999, name: `${'a'.repeat(254)}-123456`, parentId: null },
    ]);
    for (const n of nodes)
      expect(n.slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(nodes[0].slug).toBe(name);
    expect(nodes[1].slug.endsWith('-123456')).toBe(true);
    expect(new Set(nodes.map((n) => n.slug)).size).toBe(3);
  });

  it('donne un slug a un nom sans alphanumerique', () => {
    const [node] = buildThemeTree([{ id: 9, name: '///', parentId: null }]);
    expect(node.slug).toBe('theme');
  });
});

describe('uniqueSlug', () => {
  it('essaie la base, puis -{id}, puis -{id}-2...', () => {
    const taken = new Set(['duplo', 'duplo-700']);
    expect(uniqueSlug('duplo', 700, (c) => taken.has(c))).toBe('duplo-700-2');
    expect(uniqueSlug('lego', 700, (c) => taken.has(c))).toBe('lego');
  });

  it('ne laisse pas de tiret pendant apres troncature', () => {
    const base = `${'a'.repeat(250)}-bbbbbbbb`;
    // Suffixe de 4 caracteres : la troncature tombe pile sur le tiret de la base.
    const slug = uniqueSlug(base, 420, (c) => c === base.slice(0, 255));
    expect(slug).toBe(`${'a'.repeat(250)}-420`);
  });
});

describe('ThemeIndex', () => {
  const index = new ThemeIndex(buildThemeTree(RAW));

  it('resout un libelle tolerant sur la casse', () => {
    expect(index.resolve('Technic')!.id).toBe(1);
    expect(index.resolve('technic-498')!.id).toBe(498);
    expect(index.resolve('inconnu')).toBeNull();
  });

  it('rend le theme et toute sa descendance', () => {
    expect(index.descendantIds(1).sort((a, b) => a - b)).toEqual([
      1, 3, 4, 5, 6,
    ]);
  });

  it('liste les themes de tete et les enfants tries par nom', () => {
    expect(index.topLevel().map((t) => t.name)).toEqual(['Books', 'Technic']);
    expect(index.children(1).map((t) => t.name)).toEqual([
      'Competition',
      'Expert Builder',
      'Model',
    ]);
  });

  describe('theme retire', () => {
    const withRetired = new ThemeIndex([
      ...buildThemeTree(RAW),
      {
        id: 900,
        name: 'Ancien',
        slug: 'ancien',
        parentId: 1,
        path: 'Technic / Ancien',
        depth: 1,
        retired: true,
      },
      {
        id: 901,
        name: 'Vieux',
        slug: 'vieux',
        parentId: null,
        path: 'Vieux',
        depth: 0,
        retired: true,
      },
    ]);

    it('n est plus liste ni resolvable par slug', () => {
      expect(withRetired.resolve('ancien')).toBeNull();
      expect(withRetired.topLevel().map((t) => t.id)).not.toContain(901);
      expect(withRetired.children(1).map((t) => t.id)).not.toContain(900);
    });

    it('reste trouvable par id, pour le theme d un set', () => {
      expect(withRetired.findById(900)).toMatchObject({
        name: 'Ancien',
        retired: true,
      });
    });

    it('ses sets restent dans la descendance du parent', () => {
      expect(withRetired.descendantIds(1)).toContain(900);
    });
  });
});
