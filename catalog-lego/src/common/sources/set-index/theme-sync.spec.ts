import { slugify } from './theme-sync.service';

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
