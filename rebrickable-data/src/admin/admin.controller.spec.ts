import { BricksetService } from '../brickset/brickset.service';
import { CatalogService } from '../catalog/catalog.service';
import { RebrickableCsvService } from '../import/rebrickable-csv.service';
import {
  AdminController,
  ImportQueryDto,
  ImportQuerySchema,
} from './admin.controller';

describe('ImportQuerySchema', () => {
  it.each([
    // `?force` nu : Express le rend comme une chaine vide.
    ['', true],
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['false', false],
    ['0', false],
  ])('force=%j -> %s', (force, expected) => {
    expect(ImportQuerySchema.parse({ force }).force).toBe(expected);
  });

  it('absent -> false', () => {
    expect(ImportQuerySchema.parse({}).force).toBe(false);
  });

  it('refuse une valeur inconnue et un parametre inconnu', () => {
    expect(ImportQuerySchema.safeParse({ force: 'yes' }).success).toBe(false);
    expect(ImportQuerySchema.safeParse({ dry: '1' }).success).toBe(false);
  });
});

describe('AdminController', () => {
  function makeController() {
    const importer = {
      run: jest.fn().mockResolvedValue({ state: 'done' }),
    };
    const catalog = {
      counts: jest.fn().mockResolvedValue({
        sets: 1,
        setsWithBarcode: 0,
        setsWithMinifigs: 0,
        themes: 1,
      }),
      lastRuns: jest.fn().mockResolvedValue([]),
    };
    const brickset = {
      budgetStatus: jest.fn().mockResolvedValue({ used: 3, budget: 90 }),
      isConfigured: () => false,
    };
    const controller = new AdminController(
      catalog as unknown as CatalogService,
      importer as unknown as RebrickableCsvService,
      brickset as unknown as BricksetService,
    );
    return { controller, importer, catalog };
  }

  it.each([
    [{ force: '' }, true],
    [{ force: 'true' }, true],
    [{ force: '1' }, true],
    [{}, false],
  ])('import %j -> run({ force: %s })', async (raw, force) => {
    const { controller, importer } = makeController();
    await controller.importRebrickable(
      ImportQuerySchema.parse(raw) as ImportQueryDto,
    );
    expect(importer.run).toHaveBeenCalledWith({ force });
  });

  it('status : comptes, budget du jour et 10 derniers runs', async () => {
    const { controller, catalog } = makeController();
    expect(await controller.status()).toEqual({
      counts: { sets: 1, setsWithBarcode: 0, setsWithMinifigs: 0, themes: 1 },
      brickset: { configured: false, used: 3, budget: 90 },
      runs: [],
    });
    expect(catalog.lastRuns).toHaveBeenCalledWith(10);
  });

  it('n expose plus de campagne Brickset', () => {
    expect(AdminController.prototype).not.toHaveProperty('harvestBrickset');
  });
});
