/**
 * Forme normalisee d'un set LEGO, alignee sur `UnifiedItem` du monolithe
 * (`src/oauth/providers/types.ts`) afin que le gateway relaie sans transcoder.
 *
 * Deux ecarts assumes, documentes plutot que masques :
 * - `creators` reste **vide**. Un set n'a pas d'auteur expose par les catalogues ; y glisser
 *   le theme donnerait un sous-titre gratuit dans l'app au prix d'un champ qui ment. Le profil
 *   de type LEGO projette `metadata.theme.path` comme sous-titre.
 * - `releaseDate` porte une **annee seule** ("2021") : c'est la granularite des deux sources.
 */
export const LEGO_MEDIA_TYPE = 'lego' as const;

export type LegoSourceCode = 'rebrickable' | 'brickset' | 'local-index';

export interface LegoThemeRef {
  id: number | null;
  name: string | null;
  /** Chemin complet depuis la racine, pre-calcule au sync ("Technic / Star Wars"). */
  path: string | null;
}

export interface LegoSetMetadata {
  /** Numero canonique avec suffixe de variante : "42131-1". */
  setNum: string;
  /** Numero nu, tel qu'imprime sur la boite : "42131". */
  setNumber: string;
  theme: LegoThemeRef;
  numParts: number | null;
  minifigs: number | null;
  barcodes: { ean: string | null; upc: string | null };
  /** Quelles sources ont contribue a cette ligne. */
  contributedBy: LegoSourceCode[];
}

export interface UnifiedLegoSet {
  source: LegoSourceCode;
  sourceId: string;
  mediaType: typeof LEGO_MEDIA_TYPE;
  title: string;
  creators: string[];
  releaseDate?: string;
  coverUrl?: string;
  description?: string;
  metadata: LegoSetMetadata;
  rawData: unknown;
}

export interface SourceContext {
  userId: string;
  premium: boolean;
  cursor?: string;
  limit: number;
}

export interface LegoSearchResult {
  items: UnifiedLegoSet[];
  nextCursor: string | null;
}
