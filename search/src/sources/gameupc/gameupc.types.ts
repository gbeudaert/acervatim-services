import { createHash } from 'crypto';
import { z } from 'zod';

/**
 * Contrat GameUPC (UPC/EAN → identifiant BoardGameGeek), d'après le Swagger
 * `https://gameupc.com/gameupc-oas.yaml` (v1.0) **corrigé par les réponses réelles** du serveur de
 * test, capturées le 2026-11-04 (fixtures `test/fixtures/gameupc/`). Les écarts au Swagger sont
 * listés dans `acervatim-docs/agent/backend/gameupc-bgg.md` ; les plus coûteux :
 *
 * - le statut s'appelle `bgg_info_status` (le Swagger dit `bgg_status`) ;
 * - `thumbnail_url` (le Swagger écrit `thumbail_url`), `published` est une **chaîne** ;
 * - un 403 `{"message":"Forbidden"}` (passerelle) sur clé absente ou fausse, non documenté ;
 * - aucune validation du code reçu, cf. `common/barcode/gtin.ts`.
 *
 * Les schémas sont **permissifs** (`passthrough`, champs optionnels) : un champ ajouté ou retiré
 * côté GameUPC ne doit pas faire tomber le scan, seul un `upc` ou un `bgg_info` illisible le fait.
 */

// ---------- Réponses brutes (snake_case, telles que GameUPC les sert) ----------

const looseString = z.string().nullish();
/** `"2016"` en pratique, entier selon le Swagger : on accepte les deux. */
const looseYear = z.union([z.string(), z.number()]).nullish();

const WireVersionSchema = z
  .object({
    version_id: z.number().int(),
    name: z.string().nullish(),
    published: looseYear,
    language: looseString,
    language_id: z.number().nullish(),
    thumbnail_url: looseString,
    image_url: looseString,
    update_url: looseString,
    confidence: z.number().nullish(),
  })
  .passthrough();

const WireBggInfoSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    published: looseYear,
    thumbnail_url: looseString,
    image_url: looseString,
    page_url: looseString,
    data_url: looseString,
    update_url: looseString,
    confidence: z.number().nullish(),
    version_status: looseString,
    versions: z.array(WireVersionSchema).nullish(),
  })
  .passthrough();

export const WireUpcInfoSchema = z
  .object({
    status: z.string().optional(),
    upc: z.string(),
    name: looseString,
    searched_for: looseString,
    bgg_info_status: z.string().optional(),
    /** Nom du Swagger, jamais vu dans une réponse réelle : lu en repli seulement. */
    bgg_status: z.string().optional(),
    bgg_info: z.array(WireBggInfoSchema).nullish(),
    new: z.boolean().optional(),
  })
  .passthrough();
export type WireUpcInfo = z.infer<typeof WireUpcInfoSchema>;

export const WireVoteSchema = z
  .object({
    upc: z.string(),
    user_id: z.string(),
    bgg_id: z.number().int(),
    /** `0` quand le vote ne porte pas de version. */
    bgg_version: z.number().int().nullish(),
    /** ISO-8601 **sans fuseau** (`2026-11-04T07:37:48.565376`) : UTC d'après les en-têtes `Date`. */
    date: z.string(),
  })
  .passthrough();

/** Corps d'erreur applicatif (`400`, `404`) ; le `403` de la passerelle n'a que `message`. */
export const WireErrorSchema = z
  .object({ status: z.string().optional(), message: z.string().optional() })
  .passthrough();

// ---------- Modèle interne (camelCase, URLs GameUPC retirées) ----------

/**
 * `bgg_info_status`. Deux valeurs documentées ; le type reste ouvert parce qu'une troisième ne doit
 * pas casser la lecture — c'est le service de résolution qui décide quoi en faire.
 */
export type GameUpcStatus =
  'verified' | 'choose_from_bgg_info_or_search' | (string & {});

/** `version_status` : `verified`, `none` (BGG n'a pas de version) ou `choose_from_versions`. */
export type GameUpcVersionStatus =
  'verified' | 'none' | 'choose_from_versions' | (string & {});

export interface GameUpcVersion {
  versionId: number;
  name: string;
  published: number | null;
  /** Libellé anglais BGG (« French »), seul repère pour proposer d'abord l'édition de l'utilisateur. */
  language: string | null;
  thumbnailUrl: string | null;
  imageUrl: string | null;
  confidence: number | null;
}

/**
 * Un jeu proposé pour le code. **Ni `update_url` ni `data_url`** : le premier porte l'environnement
 * GameUPC et n'a de sens qu'avec notre clé, le second pointe vers `api.geekdo.com`, où le jeton BGG
 * serait ignoré. Le client reconstruit l'un, le service BGG l'autre.
 */
export interface GameUpcGame {
  bggId: number;
  name: string;
  published: number | null;
  thumbnailUrl: string | null;
  imageUrl: string | null;
  pageUrl: string | null;
  confidence: number | null;
  versionStatus: GameUpcVersionStatus | null;
  versions: GameUpcVersion[];
}

export interface GameUpcUpcInfo {
  /** Le code tel que GameUPC l'a enregistré (12 ou 13 chiffres). */
  upc: string;
  name: string | null;
  /** Termes que GameUPC a cherchés : à pré-remplir dans le champ de recherche de l'app. */
  searchedFor: string | null;
  status: GameUpcStatus;
  games: GameUpcGame[];
  /** `true` quand la consultation vient de créer l'enregistrement chez GameUPC. */
  isNew: boolean;
}

/** Vote déjà enregistré pour un utilisateur sur un code (`GET /upc/{upc}/user_id/{user_id}`). */
export interface GameUpcRecordedVote {
  upc: string;
  bggId: number;
  versionId: number | null;
  /** Date d'enregistrement, ISO-8601 UTC. */
  recordedAt: string;
}

export function toUpcInfo(wire: WireUpcInfo): GameUpcUpcInfo {
  return {
    upc: wire.upc,
    name: emptyToNull(wire.name),
    searchedFor: emptyToNull(wire.searched_for),
    status: wire.bgg_info_status ?? wire.bgg_status ?? 'unknown',
    games: (wire.bgg_info ?? []).map((g) => ({
      bggId: g.id,
      name: unescapeName(g.name),
      published: toYear(g.published),
      thumbnailUrl: emptyToNull(g.thumbnail_url),
      imageUrl: emptyToNull(g.image_url),
      pageUrl: emptyToNull(g.page_url),
      confidence: g.confidence ?? null,
      versionStatus: emptyToNull(g.version_status),
      versions: (g.versions ?? []).map((v) => ({
        versionId: v.version_id,
        name: unescapeName(v.name ?? ''),
        published: toYear(v.published),
        language: emptyToNull(v.language),
        thumbnailUrl: emptyToNull(v.thumbnail_url),
        imageUrl: emptyToNull(v.image_url),
        confidence: v.confidence ?? null,
      })),
    })),
    isNew: wire.new === true,
  };
}

function emptyToNull(s: string | null | undefined): string | null {
  const t = s?.trim();
  return t ? t : null;
}

function toYear(raw: string | number | null | undefined): number | null {
  const n = typeof raw === 'number' ? raw : Number.parseInt(raw ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Les réponses de vote portent des apostrophes échappées (`Kingdomino (K-Domino\'Z)`), pas les
 * réponses de consultation : on retire l'échappement pour ne pas l'afficher.
 */
function unescapeName(s: string): string {
  return s.replace(/\\(['"\\])/g, '$1').trim();
}

// ---------- Files, jobs et cache ----------

/** Consultations (chemin interactif) : l'utilisateur attend devant son scan. */
export const GAMEUPC_QUEUE = 'gameupc';
export const GAMEUPC_LOOKUP_JOB = 'lookup';

/**
 * Votes (« file de feedback ») : file **distincte**, pour qu'une rafale de votes en retry ne passe
 * jamais devant un scan, et pour que leur retry long (minutes) n'occupe pas la file interactive.
 */
export const GAMEUPC_FEEDBACK_QUEUE = 'gameupc-feedback';
export const GAMEUPC_VOTE_JOB = 'vote';

/**
 * Débit sortant. GameUPC ne publie **aucune** limite (seul un `429 Overloaded` est documenté) :
 * valeurs provisoires, à réaligner sur ses conditions une fois la clé de production obtenue.
 * Total ≤ 3 req/s, très en dessous de ce qu'un usage humain du scan produit.
 */
export const GAMEUPC_LOOKUP_LIMITER = { max: 2, duration: 1000 };
export const GAMEUPC_FEEDBACK_LIMITER = { max: 1, duration: 1000 };

/** Pause de la file sur `429` sans `Retry-After`. */
export const GAMEUPC_RATE_LIMIT_PAUSE_MS = 30_000;

/**
 * `quality` : ~500 ms de plus, suggestions meilleures sur les codes non vérifiés — c'est-à-dire
 * presque tous les EAN d'éditeurs français mesurés (7 sur 8). Le cache absorbe la latence.
 */
export const GAMEUPC_SEARCH_MODE = 'quality' as const;

/** Un code vérifié bouge rarement ; une suggestion peut être vérifiée par d'autres votes dès demain. */
export const VERIFIED_TTL_SECONDS = 7 * 24 * 3600;
export const UNVERIFIED_TTL_SECONDS = 24 * 3600;
/**
 * Dernière réponse connue d'un code, servie marquée `stale` quand GameUPC ne répond pas. Écrite à
 * chaque consultation sans termes de recherche, jamais lue sur le chemin nominal.
 */
export const LAST_KNOWN_TTL_SECONDS = 90 * 24 * 3600;

export interface GameUpcLookupJobData {
  /** Code **déjà normalisé** (`Gtin.upc`). */
  upc: string;
  /** Termes saisis par l'utilisateur, normalisés (cf. {@link normalizeSearch}) ; `null` = heuristique GameUPC. */
  search: string | null;
}

export interface CachedGameUpcLookup {
  info: GameUpcUpcInfo;
  fetchedAt: string;
}

export interface GameUpcVoteJobData {
  upc: string;
  bggId: number;
  versionId: number | null;
  /** Pseudonyme GameUPC de l'utilisateur, **jamais** son identifiant Acervatim. */
  voterId: string;
  /** Horodatage du choix : arbitre un vote retenté contre un choix plus récent du même utilisateur. */
  chosenAt: string;
}

export type GameUpcVoteOutcome = 'sent' | 'superseded';

/** Minuscule, espaces compactés : deux saisies équivalentes partagent la même entrée de cache. */
export function normalizeSearch(
  search: string | null | undefined,
): string | null {
  const s = search?.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
  return s ? s : null;
}

export function lookupCacheKey(upc: string, search: string | null): string {
  return search === null
    ? `gameupc:upc:${upc}`
    : `gameupc:upc:${upc}:q:${sha1(search)}`;
}

export function lastKnownCacheKey(upc: string): string {
  return `gameupc:last:${upc}`;
}

export function lookupTtlSeconds(info: GameUpcUpcInfo): number {
  return info.status === 'verified' && info.games.length > 0
    ? VERIFIED_TTL_SECONDS
    : UNVERIFIED_TTL_SECONDS;
}

/**
 * jobId du vote : un par (code, votant, choix). Un double envoi du même choix — double tap, rejeu
 * réseau de l'app — retombe sur le même job et n'en crée pas un second ; un **autre** choix est un
 * autre job, que `chosenAt` ordonne (cf. `GameUpcFeedbackProcessor`).
 */
export function voteJobId(vote: {
  upc: string;
  bggId: number;
  versionId: number | null;
  voterId: string;
}): string {
  return `gameupc-vote:${sha1(
    `${vote.upc}|${vote.bggId}|${vote.versionId ?? 0}|${vote.voterId}`,
  )}`;
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}
