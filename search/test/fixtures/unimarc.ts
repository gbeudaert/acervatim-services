/**
 * Fabrique de notices UNIMARC (réponses SRU BnF) pour les tests — aucun appel réseau. Les champs
 * reprennent les relevés réels du 2026-10-27 (étude « leviers pour lever les limitations de la
 * recherche manga ») : notices cataloguées, pré-notices (702, 500$3, 225$a = collection éditeur),
 * 2-en-1 France Loisirs.
 */
export interface UnimarcSpec {
  isbn?: string;
  /** 100$a positions 0-7 (date de création de la notice), ex "20260728". */
  created?: string;
  title: string; // 200$a
  volume?: string; // 200$h
  otherTitle?: string; // 200$e
  statement?: string; // 200$f
  edition?: string; // 205$a
  publisher?: string; // 210$c (ou 214$c)
  publisherTag?: '210' | '214';
  date?: string; // 210$d / 214$d
  collection?: string; // 225$a
  collectionVolume?: string; // 225$v
  collectionLink?: string; // 410$t (lien « collection », notices complètes)
  set?: string; // 461$t
  setVolume?: string; // 461$v
  uniform?: string; // 500$a
  original?: string; // 454$t
  sourceRange?: string; // 454$h
  authors?: [string, string][]; // 700 (nom, prénom)
  secondary?: [string, string, string?][]; // 702 (nom, prénom, rôle $c)
}

function sf(code: string, value: string | undefined): string {
  return value === undefined
    ? ''
    : `<mxc:subfield code="${code}">${value.replace(/&/g, '&amp;')}</mxc:subfield>`;
}

function df(tag: string, ...subfields: string[]): string {
  const inner = subfields.join('');
  return inner
    ? `<mxc:datafield tag="${tag}" ind1=" " ind2=" ">${inner}</mxc:datafield>`
    : '';
}

export function unimarcRecord(s: UnimarcSpec): string {
  const pubTag = s.publisherTag ?? '210';
  return `<srw:record><srw:recordData><mxc:record xmlns:mxc="info:lc/xmlns/marcxchange-v2">
    ${df('010', sf('a', s.isbn))}
    ${df('100', sf('a', s.created ? `${s.created}d2026    m  y0frey50      ba` : undefined))}
    ${df('200', sf('a', s.title), sf('e', s.otherTitle), sf('h', s.volume), sf('f', s.statement))}
    ${df('205', sf('a', s.edition))}
    ${df(pubTag, sf('c', s.publisher), sf('d', s.date))}
    ${df('225', sf('a', s.collection), sf('v', s.collectionVolume))}
    ${df('410', sf('t', s.collectionLink))}
    ${df('454', sf('t', s.original), sf('h', s.sourceRange))}
    ${df('461', sf('t', s.set), sf('v', s.setVolume))}
    ${df('500', sf('a', s.uniform))}
    ${(s.authors ?? []).map(([a, b]) => df('700', sf('a', a), sf('b', b))).join('')}
    ${(s.secondary ?? []).map(([a, b, c]) => df('702', sf('a', a), sf('b', b), sf('c', c))).join('')}
  </mxc:record></srw:recordData></srw:record>`;
}

/** Réponse SRU complète ; `total` = `numberOfRecords` annoncé (défaut : nombre de notices). */
export function sruResponse(records: string[], total = records.length): string {
  return `<srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/">
  <srw:numberOfRecords>${total}</srw:numberOfRecords>
  <srw:records>${records.join('\n')}</srw:records>
</srw:searchRetrieveResponse>`;
}

const SNK = "L'attaque des titans";
const ISAYAMA: [string, string][] = [['Isayama', 'Hajime']];

/**
 * *L'attaque des titans* (relevé du 2026-10-27, réduit) : la standard Pika (T1-T12, deux graphies
 * d'éditeur), les 2-en-1 France Loisirs **placés avant** les tomes Pika de même numéro (ordre SRU
 * qui faisait gagner « 11-12 »), la colossale Pika (454$h), un roman Pika (autre auteur).
 */
export function snkRecords(): string[] {
  const pika = (vol: number) =>
    unimarcRecord({
      isbn: `978-pika-${vol}`,
      title: SNK,
      volume: String(vol),
      publisher: vol % 2 ? 'Pika édition' : 'Pika éd.',
      date: `DL ${2013 + Math.floor(vol / 4)}`,
      uniform: 'Shingeki no kyojin',
      original: 'Shingeki no kyojin',
      authors: ISAYAMA,
    });
  const franceLoisirs = (range: string) =>
    unimarcRecord({
      isbn: `978-fl-${range}`,
      title: SNK,
      volume: range,
      publisher: 'Éditions France loisirs',
      date: '2016',
      authors: ISAYAMA,
    });
  const colossale = (vol: number, range: string) =>
    unimarcRecord({
      isbn: `978-colo-${vol}`,
      title: SNK,
      volume: String(vol),
      edition: 'Éd. colossale',
      publisher: 'Pika édition',
      date: 'DL 2015',
      sourceRange: `vol. ${range}`,
      authors: ISAYAMA,
    });
  const roman = unimarcRecord({
    isbn: '978-roman-1',
    title: 'Before the fall',
    statement: 'Ryô Suzukaze',
    publisher: 'Pika roman',
    collection: "L'attaque des Titans",
    set: "L'attaque des Titans",
    setVolume: '1',
    authors: [['Suzukaze', 'Ryô']],
  });
  return [
    franceLoisirs('1-2'),
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(pika),
    franceLoisirs('11-12'),
    pika(11),
    pika(12),
    colossale(1, '1-3'),
    colossale(2, '4-6'),
    roman,
  ];
}

/**
 * *Sakamoto Days* (Glénat) : T21 catalogué, T22 en **pré-notice** relue en entier le 2026-10-27 —
 * pas de 461 ni de 205, auteur en 702, 225$a = « Shonen manga » (collection), 500$a présent.
 */
export function sakamotoRecords(): string[] {
  return [
    unimarcRecord({
      isbn: '978-2-344-06000-1',
      created: '20260415',
      title: 'Sakamoto days',
      volume: '21',
      publisher: 'Glénat',
      publisherTag: '214',
      date: '2026',
      collection: 'Shonen manga',
      set: 'Sakamoto days',
      setVolume: '21',
      authors: [['Suzuki', 'Yūto']],
    }),
    unimarcRecord({
      isbn: '978-2-344-06864-9',
      created: '20260728',
      title: 'Sakamoto days',
      volume: 'vol. 22',
      publisher: 'Glénat',
      publisherTag: '214',
      date: '2026',
      collection: 'Shonen manga',
      uniform: 'Sakamoto days',
      secondary: [
        ['Suzuki', 'Yūto'],
        ['Fernande', 'Pierre', 'Traducteur'],
      ],
    }),
  ];
}

/**
 * *The strange house* (Kana, collection « Big Kana »), relevé du 2026-11-18. Le T1 est catalogué
 * (461 « fait partie de », 410 collection, 454 titre original) ; le T2 est une **pré-notice** : ni
 * 461 ni 410 ni 454, 225$a = « Big Kana » sans n°, le n° de tome en 200$h, les auteurs inversés
 * (700 dessinateur, 702 scénariste). Un autre titre de la collection en pré-notice complète le lot.
 */
export function strangeHouseRecords(): string[] {
  return [
    unimarcRecord({
      isbn: '978-2-505-12902-8',
      title: 'The strange house',
      volume: '1',
      statement: 'scénario, Uketsu',
      publisher: 'Kana',
      publisherTag: '214',
      date: '2025',
      collection: 'Big Kana',
      collectionLink: 'Big Kana',
      set: 'The strange house',
      setVolume: '1',
      original: 'Hen na ie',
      authors: [['Uketsu', '']],
    }),
    unimarcRecord({
      isbn: '978-2-505-12903-5',
      title: 'The strange house',
      volume: '2',
      publisher: 'Kana',
      publisherTag: '214',
      date: '2025',
      collection: 'Big Kana',
      authors: [['Kyo', 'Ayano']],
      secondary: [['Uketsu', '', 'Auteur du texte']],
    }),
    unimarcRecord({
      isbn: '978-2-505-12023-0',
      title: 'Kowloon',
      volume: '8',
      publisher: 'Kana',
      publisherTag: '214',
      date: '2025',
      collection: 'Big Kana',
    }),
  ];
}

/**
 * *Alice in Borderland* (Delcourt), relevé du 2026-11-18 : une seule édition (ISBN 978-2-7560-…)
 * cataloguée sous trois libellés successifs — « Delcourt-Akata » T1-4, « Delcourt » T5-8,
 * « Éditions Delcourt » T9-18 —, plus *Alice in Borderland retry* (Delcourt-Tonkam), un autre
 * ensemble 461 dont le 200$a commence pareil. ISBN simplifiés.
 */
export function aliceRecords(): string[] {
  const tome = (vol: number, publisher: string) =>
    unimarcRecord({
      isbn: `978-alice-${vol}`,
      title: 'Alice in Borderland',
      volume: String(vol),
      publisher,
      date: vol <= 4 ? 'impr. 2013' : 'DL 2015',
      collection: vol <= 9 ? 'Collection Také' : undefined,
      set: 'Alice in Borderland',
      setVolume: String(vol),
      authors: [['Aso', 'Haro']],
    });
  return [
    ...[1, 2, 3, 4].map((v) => tome(v, 'Delcourt-Akata')),
    ...[5, 6, 7, 8].map((v) => tome(v, 'Delcourt')),
    ...Array.from({ length: 10 }, (_, i) => tome(i + 9, 'Éditions Delcourt')),
    ...[1, 2].map((v) =>
      unimarcRecord({
        isbn: `978-retry-${v}`,
        title: 'Alice in Borderland retry',
        volume: String(v),
        publisher: 'Delcourt-Tonkam',
        set: 'Alice in Borderland retry',
        setVolume: String(v),
        authors: [['Aso', 'Haro']],
      }),
    ),
  ];
}
