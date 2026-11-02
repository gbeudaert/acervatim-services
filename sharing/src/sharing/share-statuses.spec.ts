import {
  ALL_SHARE_STATUSES,
  isAllStatuses,
  normalizeStatuses,
  parseStatuses,
  unionStatuses,
} from './share-statuses';

describe('normalizeStatuses', () => {
  it('remet dans l ordre canonique et dedoublonne', () => {
    // Deux ensembles egaux doivent avoir la meme representation, sans quoi
    // ['WISHLIST','OWNED'] et ['OWNED','WISHLIST'] divergeraient en base pour rien.
    expect(normalizeStatuses(['WISHLIST', 'OWNED', 'OWNED'])).toEqual([
      'OWNED',
      'WISHLIST',
    ]);
  });
});

describe('parseStatuses', () => {
  it('lit un tableau JSON valide', () => {
    expect(parseStatuses(['OWNED', 'IGNORED'])).toEqual(['OWNED', 'IGNORED']);
  });

  // Le sens de la defaillance qui compte : une ligne abimee ne montre RIEN. L'inverse
  // ouvrirait la collection entiere sur une valeur corrompue.
  it('rend l ensemble vide sur une valeur abimee', () => {
    expect(parseStatuses(null)).toEqual([]);
    expect(parseStatuses('OWNED')).toEqual([]);
    expect(parseStatuses({})).toEqual([]);
    expect(parseStatuses(['NOPE', 42, null])).toEqual([]);
  });

  it('ecarte les valeurs inconnues sans jeter les valides', () => {
    expect(parseStatuses(['OWNED', 'NOPE'])).toEqual(['OWNED']);
  });
});

describe('unionStatuses', () => {
  // Un membre detenant plusieurs partages actifs de la meme collection voit la reunion de ce
  // que chacun lui accorde - ni plus, ni moins.
  it('reunit plusieurs ensembles', () => {
    expect(unionStatuses([['OWNED'], ['WISHLIST']])).toEqual([
      'OWNED',
      'WISHLIST',
    ]);
  });

  it('rend l ensemble vide quand il n y a rien a reunir', () => {
    expect(unionStatuses([])).toEqual([]);
    expect(unionStatuses([[], []])).toEqual([]);
  });

  it('n invente aucun statut', () => {
    const union = unionStatuses([['OWNED'], ['OWNED']]);
    expect(union).toEqual(['OWNED']);
  });
});

describe('isAllStatuses', () => {
  it('reconnait la portee complete', () => {
    expect(isAllStatuses([...ALL_SHARE_STATUSES])).toBe(true);
    expect(isAllStatuses(['OWNED', 'WISHLIST'])).toBe(false);
  });
});
