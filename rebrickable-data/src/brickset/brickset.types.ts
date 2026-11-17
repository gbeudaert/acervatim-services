export const BRICKSET_QUEUE = 'brickset';

/**
 * Payload d'un job de la file `brickset`. **Les seuls parametres `getSets`** : le payload vit dans
 * Redis, la cle API n'y entre donc jamais - c'est le worker qui l'ajoute depuis sa configuration.
 */
export interface BricksetFetchJobData {
  params: Partial<BricksetGetSetsParams>;
}

export interface BricksetSet {
  setID: number;
  /** Numero nu tel qu'imprime sur la boite : "42131". */
  number: string;
  /** Variante de reference. Concatene au numero, donne le `set_num` Rebrickable : "42131-1". */
  numberVariant: number;
  name: string;
  year: number | null;
  theme: string | null;
  themeGroup: string | null;
  subtheme: string | null;
  pieces: number | null;
  minifigs: number | null;
  image?: { thumbnailURL?: string | null; imageURL?: string | null };
  /** La raison d'etre de cette source : Brickset est le seul catalogue gratuit a publier l'EAN/UPC. */
  barcode?: { EAN?: string | null; UPC?: string | null };
  lastUpdated?: string | null;
}

export interface BricksetGetSetsResponse {
  status: 'success' | 'error';
  message?: string;
  matches?: number;
  sets?: BricksetSet[];
}

/** Parametres `getSets` effectivement utilises : la recherche d'un code scanne. */
export interface BricksetGetSetsParams {
  /**
   * Terme de recherche. La documentation de Brickset ne cite que le numero, le nom, le theme et
   * le sous-theme ; la recherche du site trouve aussi un EAN ou un UPC (verifie le 2026-11-17),
   * et c'est sur ce comportement que repose le scan. A confirmer au premier appel reel.
   */
  query: string;
  pageNumber: number;
  pageSize: number;
}
