import { BggThing } from './bgg.types';

/**
 * Lecture de la réponse `thing` de BGG, SANS dépendance XML — même raison que le parseur UNIMARC :
 * pas de dépendance nouvelle sans accord. Le format est plat et stable (attributs `value` sur des
 * éléments vides), une extraction ciblée suffit.
 *
 * Les valeurs d'attribut peuvent contenir `>` : les motifs d'élément l'admettent entre guillemets.
 */

const ATTRS = '((?:[^>"]|"[^"]*")*)';
const ITEM_RE = new RegExp(`<item\\b${ATTRS}>([\\s\\S]*?)</item>`, 'i');
const ATTR_RE = /([\w:-]+)\s*=\s*"([^"]*)"/g;

/**
 * Première fiche de la réponse, `null` si BGG n'en rend aucune (id inconnu : `200` avec
 * `<items/>` vide). `expectedId` écarte une réponse qui porterait un autre jeu.
 */
export function parseThing(xml: string, expectedId: number): BggThing | null {
  const item = ITEM_RE.exec(xml);
  if (!item) return null;
  const itemAttrs = attrs(item[1]);
  const bggId = Number.parseInt(itemAttrs.id ?? '', 10);
  if (bggId !== expectedId) return null;
  const body = item[2];

  const names = elements(body, 'name');
  const primary = names.find((n) => n.type === 'primary')?.value;
  if (!primary) return null;

  const links = elements(body, 'link');
  const linked = (type: string) =>
    links.filter((l) => l.type === type && l.inbound !== 'true');

  const boardGameRank = elements(body, 'rank').find(
    (r) => r.type === 'subtype' && r.name === 'boardgame',
  );

  return {
    bggId,
    type: itemAttrs.type ?? 'boardgame',
    name: decode(primary),
    alternateNames: names
      .filter((n) => n.type === 'alternate' && n.value)
      .map((n) => decode(n.value)),
    yearPublished: intValue(body, 'yearpublished'),
    minPlayers: intValue(body, 'minplayers'),
    maxPlayers: intValue(body, 'maxplayers'),
    playingTime: intValue(body, 'playingtime'),
    minPlayTime: intValue(body, 'minplaytime'),
    maxPlayTime: intValue(body, 'maxplaytime'),
    minAge: intValue(body, 'minage'),
    description: textContent(body, 'description'),
    thumbnailUrl: textContent(body, 'thumbnail'),
    imageUrl: textContent(body, 'image'),
    designers: linked('boardgamedesigner').map((l) => decode(l.value)),
    publishers: linked('boardgamepublisher').map((l) => decode(l.value)),
    mechanics: linked('boardgamemechanic').map((l) => decode(l.value)),
    categories: linked('boardgamecategory').map((l) => decode(l.value)),
    expands: links
      .filter((l) => l.type === 'boardgameexpansion' && l.inbound === 'true')
      .map((l) => Number.parseInt(l.id ?? '', 10))
      .filter((id) => Number.isInteger(id)),
    rating: {
      average: numValue(body, 'average'),
      bayesAverage: numValue(body, 'bayesaverage'),
      usersRated: intValue(body, 'usersrated'),
      rank: toInt(boardGameRank?.value),
    },
  };
}

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR_RE)) out[m[1].toLowerCase()] = m[2];
  return out;
}

function elements(body: string, tag: string): Record<string, string>[] {
  const re = new RegExp(`<${tag}\\b${ATTRS}/?>`, 'gi');
  return [...body.matchAll(re)].map((m) => attrs(m[1]));
}

function intValue(body: string, tag: string): number | null {
  return toInt(elements(body, tag)[0]?.value);
}

function numValue(body: string, tag: string): number | null {
  const n = Number.parseFloat(elements(body, tag)[0]?.value ?? '');
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toInt(raw: string | undefined): number | null {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function textContent(body: string, tag: string): string | null {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(body);
  const text = m ? decode(m[1]).trim() : '';
  return text ? text : null;
}

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
};

/**
 * Décode les entités XML **et** celles que BGG double-échappe dans les descriptions
 * (`&amp;#10;` pour un saut de ligne, `&amp;mdash;`) : deux passes, la seconde ne voyant que ce que
 * la première a produit. Une entité inconnue est laissée telle quelle.
 */
export function decode(s: string): string {
  return decodeOnce(decodeOnce(s));
}

function decodeOnce(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent[0] === '#') {
      const code =
        ent[1] === 'x' || ent[1] === 'X'
          ? Number.parseInt(ent.slice(2), 16)
          : Number.parseInt(ent.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED[ent.toLowerCase()] ?? whole;
  });
}
