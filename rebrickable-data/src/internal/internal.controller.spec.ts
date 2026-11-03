import { CatalogService } from '../catalog/catalog.service';
import {
  BarcodeParamsSchema,
  InternalController,
  SetsQueryDto,
  SetsQuerySchema,
  ThemesQuerySchema,
} from './internal.controller';

describe('BarcodeParamsSchema', () => {
  it.each([
    '673419340496',
    '0673419340496',
    '673-419-340-496',
    '0 673419 340496',
    '5 702016 616331',
    '5702-0166-16331',
  ])('accepte %s (12 ou 13 chiffres, tirets et espaces toleres)', (code) => {
    expect(BarcodeParamsSchema.safeParse({ code }).success).toBe(true);
  });

  it.each([
    ['moins de 6 chiffres', '12-345'],
    ['plus de 20 chiffres', '1'.repeat(21)],
    ['lettres', '57020166163AB'],
    ['vide', ''],
  ])('refuse un code : %s', (_label, code) => {
    expect(BarcodeParamsSchema.safeParse({ code }).success).toBe(false);
  });
});

describe('SetsQuerySchema', () => {
  it('limit vaut 50 et offset 0 par defaut', () => {
    expect(SetsQuerySchema.parse({})).toEqual({ offset: 0, limit: 50 });
  });

  it('accepte limit 1 a 100, refuse au-dela', () => {
    expect(SetsQuerySchema.parse({ limit: '100' }).limit).toBe(100);
    expect(SetsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(SetsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('borne offset a 100 000', () => {
    expect(SetsQuerySchema.safeParse({ offset: '100000' }).success).toBe(true);
    expect(SetsQuerySchema.safeParse({ offset: '100001' }).success).toBe(false);
  });

  it('refuse un parametre inconnu (.strict)', () => {
    expect(SetsQuerySchema.safeParse({ q: 'cat', sort: 'name' }).success).toBe(
      false,
    );
    expect(
      ThemesQuerySchema.safeParse({ parent: 'technic', x: 1 }).success,
    ).toBe(false);
  });

  it('retire les espaces de q', () => {
    expect(SetsQuerySchema.parse({ q: ' 42131 ' }).q).toBe('42131');
  });
});

describe('InternalController', () => {
  const catalog = {
    searchSets: jest.fn().mockResolvedValue({ items: [], hasMore: false }),
    findByBarcode: jest.fn().mockResolvedValue([{ setNum: '42131-1' }]),
    getSet: jest.fn().mockResolvedValue({ setNum: '42131-1' }),
    listThemes: jest.fn().mockResolvedValue([{ slug: 'technic' }]),
  };
  const controller = new InternalController(
    catalog as unknown as CatalogService,
  );

  it('sets : transmet la requete validee', async () => {
    const query = SetsQuerySchema.parse({ theme: 'technic' }) as SetsQueryDto;
    await controller.searchSets(query);
    expect(catalog.searchSets).toHaveBeenCalledWith({
      theme: 'technic',
      offset: 0,
      limit: 50,
    });
  });

  it('by-barcode et themes : enveloppent la liste dans { items }', async () => {
    expect(await controller.byBarcode({ code: '673-419-340-496' })).toEqual({
      items: [{ setNum: '42131-1' }],
    });
    expect(catalog.findByBarcode).toHaveBeenCalledWith('673-419-340-496');
    expect(await controller.listThemes({})).toEqual({
      items: [{ slug: 'technic' }],
    });
  });
});
