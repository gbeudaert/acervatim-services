import { BggThing } from '../../sources/bgg/bgg.types';

/**
 * Issue d'une résolution de code-barres de jeu de société, telle que l'app la reçoit :
 *
 * - `verified`    : GameUPC a une correspondance validée par des humains → `candidates[0]` est le jeu.
 * - `choose`      : des suggestions non validées → l'app les présente **avec** un champ de recherche
 *                   pré-rempli par `searchedFor` (consigne GameUPC : sa première hypothèse peut être fausse).
 * - `unknown`     : aucune suggestion → l'app ne propose que la recherche (puis la saisie manuelle).
 * - `unavailable` : GameUPC injoignable et aucune réponse connue → l'app propose de réessayer ou de
 *                   saisir le jeu à la main. Transitoire, à ne pas confondre avec `unknown`.
 */
export type BarcodeResolutionStatus =
  'verified' | 'choose' | 'unknown' | 'unavailable';

export interface BoardGameVersion {
  versionId: number;
  name: string;
  published: number | null;
  /** Libellé BGG en anglais (« French ») : à l'app de mettre en avant l'édition de l'utilisateur. */
  language: string | null;
  thumbnailUrl: string | null;
  confidence: number | null;
}

export interface BoardGameCandidate {
  bggId: number;
  name: string;
  published: number | null;
  thumbnailUrl: string | null;
  imageUrl: string | null;
  /** Fiche BGG publique : cible du lien « Powered by BGG » exigé par les conditions BGG. */
  pageUrl: string | null;
  confidence: number | null;
  /** `verified` : `versions[0]` est l'édition du code ; `choose` : à faire choisir ; `none` : BGG n'en a pas. */
  versionStatus: 'verified' | 'choose' | 'none' | null;
  versions: BoardGameVersion[];
}

export interface BarcodeResolution {
  /** GTIN-13 canonique. */
  gtin: string;
  /** Forme interrogée chez GameUPC (12 chiffres pour un UPC-A ou un EAN-8). */
  upc: string;
  status: BarcodeResolutionStatus;
  searchedFor: string | null;
  candidates: BoardGameCandidate[];
  /** Fiche BGG du jeu vérifié ; `null` sans licence BGG, ou si BGG n'a pas répondu à temps. */
  details: BggThing | null;
  /** `true` : GameUPC n'a pas répondu, c'est la dernière réponse connue qui est servie. */
  stale: boolean;
}

export interface BoardGameChoice {
  bggId: number;
  versionId?: number | null;
}

/**
 * `skipped` n'est pas un échec : le choix vaut pour l'utilisateur. Il n'est simplement pas
 * transmis à GameUPC — rien à lui apprendre (`already-verified`), feedback non configuré
 * (`feedback-disabled`) ou file injoignable (`queue-unavailable`).
 */
export interface BoardGameChoiceResult {
  feedback: 'queued' | 'skipped';
  reason: 'already-verified' | 'feedback-disabled' | 'queue-unavailable' | null;
  details: BggThing | null;
}

/**
 * Jeux et versions proposés pour un code, toutes recherches confondues. Un vote ne part que pour
 * un jeu effectivement proposé : sans ce garde-fou, notre API permettrait d'associer n'importe quel
 * id BGG à n'importe quel code sous nos pseudonymes, et c'est la clé Acervatim que GameUPC
 * révoquerait.
 */
export interface OfferedCandidates {
  /** bggId → versionIds proposés. */
  games: Record<string, number[]>;
}

export const OFFERED_TTL_SECONDS = 24 * 3600;

export function offeredCacheKey(upc: string): string {
  return `gameupc:offered:${upc}`;
}
