import { BricksetSet } from '../brickset/brickset.types';
import { bricksetSetNum } from './set-index.service';

function bricksetSet(overrides: Partial<BricksetSet> = {}): BricksetSet {
  return {
    setID: 1,
    number: '42131',
    numberVariant: 1,
    name: 'App-Controlled Cat D11 Bulldozer',
    year: 2021,
    theme: 'Technic',
    themeGroup: 'Technical',
    subtheme: null,
    pieces: 3854,
    minifigs: 0,
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
