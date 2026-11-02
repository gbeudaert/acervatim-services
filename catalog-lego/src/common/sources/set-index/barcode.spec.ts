import { barcodeVariants, normalizeBarcode } from './barcode';

describe('normalizeBarcode', () => {
  it('ne garde que les chiffres', () => {
    expect(normalizeBarcode('5 702016 616 331')).toBe('5702016616331');
    expect(normalizeBarcode('0673419-340496')).toBe('0673419340496');
  });

  it('rend une chaine vide quand il n y a aucun chiffre', () => {
    expect(normalizeBarcode('----')).toBe('');
  });
});

describe('barcodeVariants', () => {
  it('ajoute la forme EAN-13 d un UPC-A scanne', () => {
    // Une boite nord-americaine scannee telle quelle (12 chiffres) doit retrouver
    // la ligne indexee sous son EAN-13, qui n'en differe que par le zero de tete.
    expect(barcodeVariants('673419340496')).toEqual([
      '673419340496',
      '0673419340496',
    ]);
  });

  it('ajoute la forme UPC-A d un EAN-13 commencant par zero', () => {
    expect(barcodeVariants('0673419340496')).toEqual([
      '0673419340496',
      '673419340496',
    ]);
  });

  it('n invente pas de variante pour un EAN-13 europeen', () => {
    // 5702016616331 ne commence pas par 0 : il n'a pas d'equivalent UPC-A.
    expect(barcodeVariants('5702016616331')).toEqual(['5702016616331']);
  });

  it('rend une liste vide sur une entree sans chiffre', () => {
    expect(barcodeVariants('abc')).toEqual([]);
  });
});
