import {
  sakamotoRecords,
  sruResponse,
  strangeHouseRecords,
  unimarcRecord,
} from '../../../test/fixtures/unimarc';
import {
  belongsToSeries,
  displayPublisher,
  inferredArtKeywords,
  matchesEdition,
  noticeCreationDate,
  normalizePublisher,
  publisherFamilies,
  readEditionRecord,
  scanSeriesTitle,
  volumeOf,
} from './edition-records';
import { parseUnimarc } from './unimarc.parser';

function read(xml: string) {
  return parseUnimarc(sruResponse([xml])).records.map(readEditionRecord)[0];
}

describe('normalizePublisher / displayPublisher', () => {
  it.each([
    ['Pika édition', 'pika', 'Pika'],
    ['Pika éd.', 'pika', 'Pika'],
    ['Pika', 'pika', 'Pika'],
    ['Pika roman', 'pika roman', 'Pika roman'],
    ['Éditions France loisirs', 'france loisirs', 'France loisirs'],
    ['Glénat', 'glenat', 'Glénat'],
    ['Ki-oon', 'ki oon', 'Ki-oon'],
  ])('%s → clé %s, libellé %s', (raw, key, label) => {
    expect(normalizePublisher(raw)).toBe(key);
    expect(displayPublisher(raw)).toBe(label);
  });

  it('absent → clé vide, libellé null', () => {
    expect(normalizePublisher(null)).toBe('');
    expect(displayPublisher(undefined)).toBeNull();
  });
});

describe('noticeCreationDate (100$a)', () => {
  it.each([
    ['20260728d2026    m  y0frey50      ba', '2026-07-28'],
    ['20191301d2019', null], // mois 13 : pas une date
    ['d2019', null],
    [undefined, null],
  ])('%s → %s', (raw, expected) => {
    expect(noticeCreationDate(raw)).toBe(expected);
  });
});

describe('readEditionRecord — pré-notice (Sakamoto Days T22)', () => {
  const [, prenotice] = sakamotoRecords();
  const r = read(prenotice);

  it("appartient à la série malgré 225$a = « Shonen manga » (collection de l'éditeur)", () => {
    // Sans 461, 225$a n'est qu'un des titres candidats : il ne masque plus 500$a/200$a.
    expect(r.collectionKey).toBe('shonen manga');
    expect(belongsToSeries(r, 'sakamoto days')).toBe(true);
  });

  it('lit le n° en 200$h (« vol. 22 ») et la date de création', () => {
    expect(volumeOf(r, 'sakamoto days')).toBe(22);
    expect(r.noticeCreatedAt).toBe('2026-07-28');
  });

  it("lit l'auteur en 702 et écarte le traducteur", () => {
    expect(r.authors).toEqual([
      { surname: 'Suzuki', given: 'Yūto', full: 'Yūto Suzuki' },
    ]);
  });
});

describe('volumeOf', () => {
  it("ne croit pas le $v d'une collection éditeur", () => {
    const r = read(
      unimarcRecord({
        title: 'Sakamoto days',
        collection: 'Shonen manga',
        collectionVolume: '123',
        volume: '5',
      }),
    );
    expect(volumeOf(r, 'sakamoto days')).toBe(5);
  });
});

describe('matchesEdition — pré-notice d’édition d’art sans 205', () => {
  const r = read(
    unimarcRecord({
      title: 'Hellsing perfect edition',
      volume: '5',
      uniform: 'Hellsing',
    }),
  );

  it("n'est pas rangée en standard", () => {
    expect(inferredArtKeywords(r, 'hellsing')).toEqual(['perfect']);
    expect(matchesEdition(r, '', null, 'hellsing')).toBe(false);
  });

  it("rejoint l'édition d'art qui partage le mot-clé", () => {
    expect(matchesEdition(r, 'perfect', 'Perfect edition', 'hellsing')).toBe(
      true,
    );
    expect(matchesEdition(r, 'colossale', 'Éd. colossale', 'hellsing')).toBe(
      false,
    );
  });
});

describe('inferredArtKeywords — les mots du titre de série ne comptent pas', () => {
  it('« Perfect World » sans 205 : aucun mot-clé, la standard reste standard', () => {
    const r = read(unimarcRecord({ title: 'Perfect World', volume: '3' }));
    expect(inferredArtKeywords(r, 'perfect world')).toEqual([]);
    expect(matchesEdition(r, '', null, 'perfect world')).toBe(true);
  });

  it('retrait en multi-ensemble : « Perfect World perfect edition » garde un perfect', () => {
    const r = read(
      unimarcRecord({ title: 'Perfect World perfect edition', volume: '1' }),
    );
    expect(inferredArtKeywords(r, 'perfect world')).toEqual(['perfect']);
  });

  it('une notice avec 205 ne déduit rien de son titre', () => {
    const r = read(
      unimarcRecord({
        title: 'Hellsing perfect edition',
        edition: 'Perfect edition',
      }),
    );
    expect(inferredArtKeywords(r, 'hellsing')).toEqual([]);
  });
});

describe('belongsToSeries', () => {
  it('461$t fait autorité : un 200$a identique ne suffit pas si l’ensemble diffère', () => {
    const r = read(
      unimarcRecord({ title: 'Naruto', set: 'Naruto : les romans' }),
    );
    expect(belongsToSeries(r, 'naruto')).toBe(false);
    expect(belongsToSeries(r, 'naruto les romans')).toBe(true);
  });

  it('sans 461 : 225$a = série reste membre malgré un 500$a japonais', () => {
    const r = read(
      unimarcRecord({
        title: 'Le chat porte-bonheur',
        collection: 'Le pacte des yôkai',
        uniform: 'Natsume yūjinchō',
      }),
    );
    expect(belongsToSeries(r, 'le pacte des yokai')).toBe(true);
  });

  it('pré-notice Sakamoto : 225$a « Shonen manga » ≠ clé, mais 500$a/200$a = clé', () => {
    const r = read(sakamotoRecords()[1]);
    expect(belongsToSeries(r, 'sakamoto days')).toBe(true);
  });
});

describe('scanSeriesTitle — titre de série rendu par le scan', () => {
  const series = (xml: string) =>
    scanSeriesTitle(parseUnimarc(sruResponse([xml])).records[0]);

  it('notice cataloguée : 461$t fait autorité (The strange house T1)', () => {
    const [t1] = strangeHouseRecords();
    expect(series(t1)).toBe('The strange house');
  });

  it("pré-notice : 225$a = collection de l'éditeur, la série est 200$a (The strange house T2)", () => {
    const [, t2] = strangeHouseRecords();
    expect(series(t2)).toBe('The strange house');
  });

  it('pré-notice Glénat : « Shonen manga » n’est pas la série (Sakamoto days T22)', () => {
    const [, prenotice] = sakamotoRecords();
    expect(series(prenotice)).toBe('Sakamoto days');
  });

  it('225$v sans 200$h : la série est en 225, 200$a porte le titre du tome', () => {
    const xml = unimarcRecord({
      title: 'Le chat porte-bonheur',
      collection: 'Le pacte des yôkai',
      collectionVolume: '3',
      uniform: 'Natsume yūjinchō',
    });
    expect(series(xml)).toBe('Le pacte des yôkai');
  });

  it('225 repris en 410$t : collection numérotée, jamais la série', () => {
    const xml = unimarcRecord({
      title: 'Montage',
      collection: 'Big Kana',
      collectionVolume: '6',
      collectionLink: 'Big Kana',
    });
    expect(series(xml)).toBe('Montage');
  });

  it('aucun n° : 200$a, sauf si le titre uniforme 500$a désigne la 225', () => {
    expect(
      series(unimarcRecord({ title: 'Montage', collection: 'Big Kana' })),
    ).toBe('Montage');
    expect(
      series(
        unimarcRecord({
          title: 'Le chat porte-bonheur',
          collection: 'Le pacte des yôkai',
          uniform: 'Le pacte des yôkai',
        }),
      ),
    ).toBe('Le pacte des yôkai');
  });

  it('sans 225 : 200$a', () => {
    expect(series(unimarcRecord({ title: 'Death note', volume: '2' }))).toBe(
      'Death note',
    );
  });
});

describe('publisherFamilies — libellés successifs d’un même éditeur', () => {
  const range = (from: number, to: number) =>
    new Set(Array.from({ length: to - from + 1 }, (_, i) => from + i));

  it('Alice in Borderland : trois libellés qui se succèdent forment une seule famille', () => {
    expect(
      publisherFamilies(
        new Map([
          ['delcourt akata', range(1, 4)],
          ['delcourt', range(5, 18)],
        ]),
      ),
    ).toEqual([['delcourt', 'delcourt akata']]);
  });

  it('My hero academia : les romans Ki-oon reprennent des n° du manga, ils restent à part', () => {
    expect(
      publisherFamilies(
        new Map([
          ['ki oon roman', range(1, 5)],
          ['ki oon', range(1, 42)],
          ['hachette jeunesse', range(1, 7)],
        ]),
      ),
    ).toEqual([['ki oon'], ['hachette jeunesse'], ['ki oon roman']]);
  });

  it('2-en-1 France Loisirs : collision avec le libellé principal, famille à part', () => {
    expect(
      publisherFamilies(
        new Map([
          ['france loisirs', new Set([1, 11])],
          ['pika', range(1, 12)],
        ]),
      ),
    ).toEqual([['pika'], ['france loisirs']]);
  });

  it('glouton déterministe : le plus fourni absorbe d’abord, un libellé ne rejoint qu’une famille', () => {
    // A (1-10) absorbe C (11-15), puis B (11-12) croise C : il ouvre sa propre famille.
    expect(
      publisherFamilies(
        new Map([
          ['b', range(11, 12)],
          ['a', range(1, 10)],
          ['c', range(11, 15)],
        ]),
      ),
    ).toEqual([['a', 'c'], ['b']]);
  });
});
