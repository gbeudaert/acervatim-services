import {
  CollectionTypeCode,
  ItemSourceCode,
  UnifiedItem,
} from '../../common/internal/contracts';

/**
 * Representation normalisee d'un resultat externe. Chaque adapter mappe sa reponse brute vers
 * cette forme avant retour a l'API ; `rawData` conserve la reponse d'origine pour rejouer le
 * mapping si besoin.
 *
 * **La definition vit dans le contrat inter-services**, pas ici : elle franchit une frontiere
 * (les catalogs la recoivent dans `POST /internal/sources/snapshot` et leurs profils de type la
 * mappent vers la verite curee d'un noeud). La re-declarer localement ferait deux definitions
 * d'une meme forme, vouees a diverger.
 */
export type { UnifiedItem };

export interface AdapterContext {
  userId: string;
  cursor?: string;
  limit: number;
}

export interface AdapterSearchResult {
  items: UnifiedItem[];
  nextCursor: string | null;
}

/**
 * Contrat unique pour toute source externe (Discogs, MAL, TMDB, ...).
 * `search` est le point d'entrée du `GET /v1/search` (recherche texte libre).
 * `searchByBarcode` est une capacité OPTIONNELLE : seules les sources qui exposent
 * une recherche par code-barres (EAN/UPC) l'implémentent (ex: Discogs pour le vinyle).
 * `fetchDetails` sert au `POST /v1/items` pour récupérer le détail complet d'une ressource.
 */
export interface SourceAdapter {
  readonly source: ItemSourceCode;
  readonly mediaType: CollectionTypeCode;

  search(query: string, ctx: AdapterContext): Promise<AdapterSearchResult>;
  searchByBarcode?(
    barcode: string,
    ctx: AdapterContext,
  ): Promise<AdapterSearchResult>;
  fetchDetails(id: string, ctx: AdapterContext): Promise<UnifiedItem>;
}
