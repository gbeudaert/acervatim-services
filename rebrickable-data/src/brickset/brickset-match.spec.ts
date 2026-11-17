import { barcodeVariants } from './barcode';
import {
  bricksetPatch,
  bricksetSetNum,
  carriesCode,
  plausibleCode,
} from './brickset-match';
import { BricksetSet } from './brickset.types';

function bricksetSet(overrides: Partial<BricksetSet> = {}): BricksetSet {
  return {
    setID: 31000,
    number: '42131',
    numberVariant: 1,
    name: 'App-Controlled Cat D11 Bulldozer',
    year: 2021,
    theme: 'Technic',
    themeGroup: 'Technical',
    subtheme: null,
    pieces: 3854,
    minifigs: 0,
    barcode: { EAN: '5702016616331', UPC: '673419340496' },
    ...overrides,
  };
}

describe('bricksetSetNum', () => {
  it('recompose le numero canonique Rebrickable', () => {
    expect(bricksetSetNum(bricksetSet())).toBe('42131-1');
  });

  it('conserve une variante superieure a 1', () => {
    expect(bricksetSetNum(bricksetSet({ numberVariant: 2 }))).toBe('42131-2');
  });

  it('retombe sur la variante 1 quand Brickset ne la renseigne pas', () => {
    // Brickset rend 0 (ou rien) sur certaines fiches ; Rebrickable, lui, suffixe
    // toujours. Sans ce repli, la jointure raterait toute la ligne.
    expect(bricksetSetNum(bricksetSet({ numberVariant: 0 }))).toBe('42131-1');
  });

  it('refuse une fiche sans numero plutot que de fabriquer une cle', () => {
    expect(bricksetSetNum(bricksetSet({ number: '' }))).toBeNull();
  });
});

describe('bricksetPatch', () => {
  const empty = { ean: null, upc: null, bricksetId: null };

  it('n ecrit que ean, upc et bricksetId, normalises', () => {
    expect(
      bricksetPatch(
        bricksetSet({ barcode: { EAN: '5 702016 616331', UPC: null } }),
        empty,
      ),
    ).toEqual({ ean: '5702016616331', bricksetId: 31000 });
  });

  it('n efface jamais un code connu par une valeur vide', () => {
    const patch = bricksetPatch(
      bricksetSet({ barcode: { EAN: '', UPC: '673419340496' } }),
      { ean: '5702016616331', upc: null, bricksetId: 31000 },
    );
    expect(patch).toEqual({ upc: '673419340496' });
    expect(patch).not.toHaveProperty('ean');
  });

  it('ignore une fiche sans aucun code, y compris son bricksetId', () => {
    expect(
      bricksetPatch(bricksetSet({ barcode: { EAN: '', UPC: null } }), empty),
    ).toBeNull();
    expect(
      bricksetPatch(bricksetSet({ barcode: undefined }), empty),
    ).toBeNull();
  });

  it('ignore un code implausible', () => {
    expect(
      bricksetPatch(bricksetSet({ barcode: { EAN: '0', UPC: 'N/A' } }), empty),
    ).toBeNull();
  });

  it('n ecrit rien quand tout est deja connu', () => {
    expect(
      bricksetPatch(bricksetSet(), {
        ean: '5702016616331',
        upc: '673419340496',
        bricksetId: 31000,
      }),
    ).toBeNull();
  });
});

describe('plausibleCode', () => {
  it('ramene un GTIN-14 a zero de tete a son EAN-13, la forme qu un scan retrouve', () => {
    expect(plausibleCode('05702016616331')).toBe('5702016616331');
    expect(plausibleCode('0 5702016 616331')).toBe('5702016616331');
  });

  it('garde un GTIN-14 sans zero de tete tel quel', () => {
    expect(plausibleCode('15702016616338')).toBe('15702016616338');
  });

  it('rejette les codes trop courts ou trop longs', () => {
    expect(plausibleCode('1234567')).toBeNull();
    expect(plausibleCode('123456789012345')).toBeNull();
  });
});

describe('carriesCode', () => {
  it('reconnait le code scanne dans l EAN ou dans l UPC', () => {
    expect(carriesCode(bricksetSet(), barcodeVariants('5702016616331'))).toBe(
      true,
    );
    expect(carriesCode(bricksetSet(), barcodeVariants('673419340496'))).toBe(
      true,
    );
  });

  it('reconnait un UPC scanne sous sa forme EAN-13 a zero de tete', () => {
    expect(carriesCode(bricksetSet(), barcodeVariants('0673419340496'))).toBe(
      true,
    );
  });

  it('ecarte une fiche rendue par `query` pour une autre raison', () => {
    // `query` cherche aussi dans les noms et les numeros.
    expect(
      carriesCode(
        bricksetSet({ barcode: { EAN: '5702016999999', UPC: null } }),
        barcodeVariants('5702016616331'),
      ),
    ).toBe(false);
    expect(
      carriesCode(
        bricksetSet({ barcode: undefined }),
        barcodeVariants('5702016616331'),
      ),
    ).toBe(false);
  });
});
