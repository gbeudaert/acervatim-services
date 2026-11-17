import { expandUpcE, hasValidCheckDigit, normalizeGtin } from './gtin';

describe('normalizeGtin', () => {
  it('garde un EAN-13 tel quel, préfixe ISBN compris', () => {
    // Kingdomino (Blue Orange) et Dixit FR 2022, dont l'EAN est un ISBN.
    expect(normalizeGtin('3664824001215')).toEqual({
      gtin13: '3664824001215',
      upc: '3664824001215',
      format: 'ean_13',
    });
    expect(normalizeGtin('9782370990822')?.upc).toBe('9782370990822');
  });

  it('envoie un UPC-A sous sa forme à 12 chiffres, quelle que soit la forme scannée', () => {
    // GameUPC indexe la chaîne : `019962194719` est vérifié, `0019962194719` est un autre
    // enregistrement. Les quatre formes doivent converger.
    const expected = {
      gtin13: '0019962194719',
      upc: '019962194719',
    };
    expect(normalizeGtin('019962194719')).toMatchObject({
      ...expected,
      format: 'upc_a',
    });
    expect(normalizeGtin('19962194719')).toMatchObject({
      ...expected,
      format: 'upc_a',
    });
    expect(normalizeGtin('0019962194719')).toMatchObject(expected);
    expect(normalizeGtin('00019962194719')).toMatchObject(expected);
  });

  it('ignore espaces et tirets de saisie', () => {
    expect(normalizeGtin(' 3664824 001215 ')?.gtin13).toBe('3664824001215');
    expect(normalizeGtin('3-664824-00121-5')?.gtin13).toBe('3664824001215');
  });

  it('rejette une clé de contrôle fausse au lieu de la transmettre', () => {
    // GameUPC l'accepte et crée un enregistrement vide (`new: true`).
    expect(normalizeGtin('3664824001216')).toBeNull();
    expect(normalizeGtin('019962194718')).toBeNull();
  });

  it('rejette ce qui n’est pas un GTIN de vente au détail', () => {
    // `abc` devient `000000000000` chez GameUPC, `123` est complété en `000000000123`.
    expect(normalizeGtin('abc')).toBeNull();
    expect(normalizeGtin('')).toBeNull();
    expect(normalizeGtin('123')).toBeNull();
    expect(normalizeGtin('123456789')).toBeNull();
    expect(normalizeGtin('3664824O01215')).toBeNull();
    // GTIN-14 d'indicateur 1 : un carton, pas une boîte de jeu.
    expect(normalizeGtin('13664824001212')).toBeNull();
  });

  it('lit 8 chiffres comme un EAN-8 par défaut', () => {
    expect(normalizeGtin('96385074')).toEqual({
      gtin13: '0000096385074',
      upc: '000096385074',
      format: 'ean_8',
    });
  });

  it('développe un UPC-E quand le lecteur l’annonce, au lieu de compléter par des zéros', () => {
    // `01234565` est une clé valide en EAN-8 ET en UPC-E : seul le format tranche.
    expect(normalizeGtin('01234565')?.format).toBe('ean_8');
    expect(normalizeGtin('01234565', 'upc_e')).toEqual({
      gtin13: '0012345000065',
      upc: '012345000065',
      format: 'upc_e',
    });
  });

  it('rejette un UPC-E dont la forme développée a une clé fausse', () => {
    expect(normalizeGtin('01234566', 'upc_e')).toBeNull();
  });
});

describe('expandUpcE', () => {
  it.each([
    // Dernier chiffre 0-2 : fabricant XX{d}00 / produit 00YYY.
    ['04252614', '042100005264'],
    // 3 : fabricant XXX00 / produit 000YY.
    ['01234531', '012300000451'],
    // 4 : fabricant XXXX0 / produit 0000Y.
    ['01234546', '012340000056'],
    // 5-9 : fabricant XXXXX / produit 0000d.
    ['01234565', '012345000065'],
  ])('%s -> %s', (upcE, upcA) => {
    expect(expandUpcE(upcE)).toBe(upcA);
  });

  it('refuse un système de numérotation autre que 0 ou 1', () => {
    expect(expandUpcE('21234565')).toBeNull();
  });
});

describe('hasValidCheckDigit', () => {
  it('vaut pour toutes les longueurs GS1', () => {
    expect(hasValidCheckDigit('96385074')).toBe(true);
    expect(hasValidCheckDigit('019962194719')).toBe(true);
    expect(hasValidCheckDigit('3421272101337')).toBe(true);
    expect(hasValidCheckDigit('3421272101338')).toBe(false);
  });
});
