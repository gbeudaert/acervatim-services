export const BRICKSET_QUEUE = 'brickset';

export interface BricksetFetchJobData {
  url: string;
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

/** Parametres `getSets` effectivement utilises par le moissonneur. */
export interface BricksetGetSetsParams {
  pageNumber: number;
  pageSize: number;
  /** Format attendu par Brickset : "yyyy-MM-dd". Arme la campagne incrementale. */
  updatedSince?: string;
  orderBy?: string;
}
