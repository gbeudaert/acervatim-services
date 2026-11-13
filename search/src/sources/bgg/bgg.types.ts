/**
 * BoardGameGeek XML API2, réduit à `thing` (fiche d'un jeu par identifiant).
 * Doc : https://boardgamegeek.com/wiki/page/BGG_XML_API2
 *
 * Trois règles BGG gouvernent tout ce dossier :
 * - **jeton Bearer côté serveur seulement** : il est lu dans le client HTTP, jamais placé dans un
 *   job, une clé de cache ou une réponse ;
 * - **`boardgamegeek.com` sans `www`** : sur `www.`, le jeton est ignoré (et l'appel refusé) ;
 * - **≤ 1 requête / 2 s**, avec backoff sur `429`/`503` : le limiter de la file `bgg`.
 *
 * Licence : usage commercial soumis à accord écrit de BGG. Sans `BGG_API_TOKEN`, rien ne part et la
 * résolution s'appuie sur les seules données GameUPC.
 */

export const BGG_QUEUE = 'bgg';
export const BGG_THING_JOB = 'thing';

/** Exigence BGG : au plus une requête toutes les deux secondes, tous utilisateurs confondus. */
export const BGG_LIMITER = { max: 1, duration: 2000 };

/** Pause de la file sur `429`/`503` sans `Retry-After`. */
export const BGG_RATE_LIMIT_PAUSE_MS = 60_000;

/**
 * Cache long : une fiche BGG bouge peu (classement et notes exceptés), et chaque appel évité
 * ménage la limite. Une absence (id inconnu) est revue plus tôt.
 */
export const THING_TTL_SECONDS = 30 * 24 * 3600;
export const THING_MISS_TTL_SECONDS = 7 * 24 * 3600;

/**
 * Fiche d'un jeu, telle que BGG la donne : aucun champ n'est réécrit (les conditions BGG
 * interdisent de modifier les données), seules les entités XML et HTML sont décodées.
 */
export interface BggThing {
  bggId: number;
  /** `boardgame`, `boardgameexpansion`, `boardgameaccessory`. */
  type: string;
  /** Nom principal (souvent anglais). */
  name: string;
  /** Noms alternatifs, dont les titres français quand BGG les connaît. */
  alternateNames: string[];
  yearPublished: number | null;
  minPlayers: number | null;
  maxPlayers: number | null;
  playingTime: number | null;
  minPlayTime: number | null;
  maxPlayTime: number | null;
  minAge: number | null;
  description: string | null;
  thumbnailUrl: string | null;
  imageUrl: string | null;
  designers: string[];
  publishers: string[];
  mechanics: string[];
  categories: string[];
  /** Pour une extension : identifiants des jeux de base (`link` `boardgameexpansion` `inbound`). */
  expands: number[];
  rating: {
    average: number | null;
    bayesAverage: number | null;
    usersRated: number | null;
    /** Rang « Board Game Rank » ; `null` si BGG répond `Not Ranked`. */
    rank: number | null;
  };
}

/** Enveloppe de cache : `thing: null` = « BGG ne connaît pas cet id », distinct d'un id jamais lu. */
export interface CachedBggThing {
  thing: BggThing | null;
}

export interface BggThingJobData {
  bggId: number;
}

export function thingCacheKey(bggId: number): string {
  return `bgg:thing:${bggId}`;
}
