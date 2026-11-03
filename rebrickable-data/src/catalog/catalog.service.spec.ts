import { NotFoundException } from '@nestjs/common';
import { LegoSet, LegoTheme } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogService, setNumber } from './catalog.service';

const THEMES: LegoTheme[] = [
  {
    id: 1,
    name: 'Technic',
    slug: 'technic',
    parentId: null,
    path: 'Technic',
    depth: 0,
    retiredAt: null,
  },
  {
    id: 3,
    name: 'Competition',
    slug: 'competition',
    parentId: 1,
    path: 'Technic / Competition',
    depth: 1,
    retiredAt: null,
  },
  {
    id: 5,
    name: 'Model',
    slug: 'model',
    parentId: 1,
    path: 'Technic / Model',
    depth: 1,
    retiredAt: null,
  },
  {
    id: 6,
    name: 'Airport',
    slug: 'airport',
    parentId: 5,
    path: 'Technic / Model / Airport',
    depth: 2,
    retiredAt: null,
  },
  {
    id: 158,
    name: 'Star Wars',
    slug: 'star-wars',
    parentId: null,
    path: 'Star Wars',
    depth: 0,
    retiredAt: null,
  },
  {
    id: 900,
    name: 'Ancien',
    slug: 'ancien',
    parentId: 1,
    path: 'Technic / Ancien',
    depth: 1,
    retiredAt: new Date('2026-11-03T03:00:00Z'),
  },
];

function legoSet(overrides: Partial<LegoSet> = {}): LegoSet {
  return {
    setNum: '42131-1',
    name: 'Cat D11 Bulldozer',
    year: 2021,
    themeId: 1,
    numParts: 3854,
    minifigs: 0,
    imageUrl: 'https://cdn.rebrickable.com/media/sets/42131-1.jpg',
    ean: null,
    upc: null,
    bricksetId: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeCatalog(rows: LegoSet[] = []) {
  const prisma = {
    legoTheme: {
      findMany: jest.fn().mockResolvedValue(THEMES),
      count: jest.fn(),
    },
    legoSet: {
      findMany: jest.fn().mockResolvedValue(rows),
      findUnique: jest.fn().mockResolvedValue(rows[0] ?? null),
      count: jest.fn(),
    },
  };
  const service = new CatalogService(prisma as unknown as PrismaService);
  return { service, prisma };
}

describe('CatalogService.searchSets', () => {
  it('q : numero qui commence par la valeur, ou nom qui la contient, tri year desc setNum asc', async () => {
    const { service, prisma } = makeCatalog([legoSet()]);

    const page = await service.searchSets({
      q: ' 42131 ',
      offset: 0,
      limit: 10,
    });

    expect(prisma.legoSet.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { setNum: { startsWith: '42131' } },
          { name: { contains: '42131' } },
        ],
      },
      orderBy: [{ year: 'desc' }, { setNum: 'asc' }],
      skip: 0,
      take: 11,
    });
    expect(page).toEqual({
      items: [
        {
          setNum: '42131-1',
          setNumber: '42131',
          name: 'Cat D11 Bulldozer',
          year: 2021,
          numParts: 3854,
          minifigs: 0,
          imageUrl: 'https://cdn.rebrickable.com/media/sets/42131-1.jpg',
          theme: { id: 1, name: 'Technic', path: 'Technic', slug: 'technic' },
          barcodes: { ean: null, upc: null },
          contributedBy: ['rebrickable'],
        },
      ],
      hasMore: false,
    });
  });

  it('theme : le theme et toute sa descendance', async () => {
    const { service, prisma } = makeCatalog();

    await service.searchSets({ theme: 'Technic', offset: 20, limit: 10 });

    const call = prisma.legoSet.findMany.mock.calls[0][0];
    // 900 est retire mais ses sets restent des sets Technic.
    expect(call.where.themeId.in.sort((a: number, b: number) => a - b)).toEqual(
      [1, 3, 5, 6, 900],
    );
    expect(call.where.OR).toBeUndefined();
    expect(call.skip).toBe(20);
  });

  it('theme inconnu : 404', async () => {
    const { service } = makeCatalog();
    await expect(
      service.searchSets({ theme: 'inconnu', offset: 0, limit: 10 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('hasMore quand la base rend une ligne de plus que la limite', async () => {
    const { service } = makeCatalog([
      legoSet({ setNum: 'a-1' }),
      legoSet({ setNum: 'b-1' }),
      legoSet({ setNum: 'c-1' }),
    ]);

    const page = await service.searchSets({ offset: 0, limit: 2 });

    expect(page.hasMore).toBe(true);
    expect(page.items.map((i) => i.setNum)).toEqual(['a-1', 'b-1']);
  });
});

describe('CatalogService.findByBarcode', () => {
  it('cherche toutes les variantes du code dans ean et upc, 20 au plus', async () => {
    const { service, prisma } = makeCatalog([
      legoSet({ ean: '0673419340496', bricksetId: 31000 }),
    ]);

    const items = await service.findByBarcode('0673-4193-40496');

    expect(prisma.legoSet.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { ean: { in: ['0673419340496', '673419340496'] } },
          { upc: { in: ['0673419340496', '673419340496'] } },
        ],
      },
      orderBy: [{ year: 'desc' }, { setNum: 'asc' }],
      take: 20,
    });
    expect(items[0].contributedBy).toEqual(['rebrickable', 'brickset']);
  });

  it('rend une liste vide sans interroger la base quand il n y a aucun chiffre', async () => {
    const { service, prisma } = makeCatalog();
    expect(await service.findByBarcode('---')).toEqual([]);
    expect(prisma.legoSet.findMany).not.toHaveBeenCalled();
  });
});

describe('CatalogService.getSet', () => {
  it('set inconnu : 404', async () => {
    const { service } = makeCatalog([]);
    await expect(service.getSet('99999-9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('theme absent de l arbre : theme null plutot qu une erreur', async () => {
    const { service } = makeCatalog([legoSet({ themeId: 9999 })]);
    expect((await service.getSet('42131-1')).theme).toBeNull();
  });
});

describe('CatalogService.listThemes', () => {
  it('sans parent : les themes de tete', async () => {
    const { service } = makeCatalog();
    expect((await service.listThemes()).map((t) => t.slug)).toEqual([
      'star-wars',
      'technic',
    ]);
  });

  it('avec parent : ses enfants directs', async () => {
    const { service } = makeCatalog();
    expect((await service.listThemes('technic')).map((t) => t.slug)).toEqual([
      'competition',
      'model',
    ]);
  });

  it('parent inconnu : 404', async () => {
    const { service } = makeCatalog();
    await expect(service.listThemes('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('CatalogService, themes retires', () => {
  it('ne sont ni listes ni resolvables par slug', async () => {
    const { service } = makeCatalog();
    expect(
      (await service.listThemes('technic')).map((t) => t.slug),
    ).not.toContain('ancien');
    await expect(service.listThemes('ancien')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.searchSets({ theme: 'ancien', offset: 0, limit: 10 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('restent affiches comme theme d un set qui les reference', async () => {
    const { service } = makeCatalog([legoSet({ themeId: 900 })]);
    expect((await service.getSet('42131-1')).theme).toEqual({
      id: 900,
      name: 'Ancien',
      path: 'Technic / Ancien',
      slug: 'ancien',
    });
  });
});

describe('setNumber', () => {
  it('retire le seul suffixe de version', () => {
    expect(setNumber('42131-1')).toBe('42131');
    expect(setNumber('113-2-DBASE-1')).toBe('113-2-DBASE');
    expect(setNumber('sans-suffixe')).toBe('sans-suffixe');
  });
});
