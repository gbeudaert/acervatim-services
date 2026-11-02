/**
 * Contrat des routes `/internal/*` - la frontiere entre services.
 *
 * C'est ce fichier, et non les imports TypeScript, qui definit ce que les services se
 * partagent : toute route ajoutee ici est un engagement, toute donnee qui n'y passe pas
 * n'est pas partagee (6 de
 * ../../../../acervatim-docs/agent/backend/architecture-microservices.md).
 *
 * Il est **identique dans tous les services** - c'est le `libs/contracts` de la cible,
 * duplique tant que le monorepo Nest n'existe pas. Le modifier d'un seul cote est le
 * moyen le plus simple de casser la constellation en silence : changer une forme ici se
 * fait dans tous les services du meme coup.
 *
 * Aucune de ces routes n'est exposee par le gateway vers l'exterieur.
 */

/** Statuts de possession d'un item, tels qu'ils circulent entre `sharing` et les catalogs. */
export const SHARE_STATUSES = ['OWNED', 'WISHLIST', 'IGNORED'] as const;
export type ShareStatus = (typeof SHARE_STATUSES)[number];

/** Codes de type de collection. Le `typeCode` est la cle de routage du gateway. */
export const COLLECTION_TYPE_CODES = [
  'vinyl',
  'manga',
  'movie',
  'book',
  'game',
] as const;
export type CollectionTypeCode = (typeof COLLECTION_TYPE_CODES)[number];

// --------------------------------------------------------------------------- sharing

/**
 * `GET /internal/access?userId=&collectionId=` - servie par `sharing`, appelee par le
 * gateway (3.1). C'est litteralement le contrat de `CollectionAccessService.resolveAccess`
 * du monolithe. `null` = aucun acces, et on ne dit pas pourquoi.
 */
export interface InternalAccess {
  collectionId: string;
  /** Proprietaire de la collection : c'est SON premium qui conditionne la lecture. */
  ownerUserId: string;
  role: 'owner' | 'shared';
  /**
   * Statuts exposes au requerant. Le proprietaire recoit les trois ; un membre recoit
   * l'union de ce que ses partages actifs lui accordent. Jamais fourni par le client.
   */
  statuses: ShareStatus[];
}

// --------------------------------------------------------------------------- catalog

/**
 * `GET /internal/collections/:id/owner` - servie par `catalog-*`, appelee par `sharing`.
 *
 * `name` complete le contrat du 6, qui ne listait que `{ ownerUserId, typeCode }`. La raison
 * est concrete : `sharing` doit denormaliser le nom a la creation du partage, faute de
 * pouvoir joindre `collections` (voir son schema Prisma). Le lui faire chercher par un
 * second appel serait un aller-retour de plus pour une colonne que cette requete lit deja.
 */
export interface InternalCollectionOwner {
  collectionId: string;
  ownerUserId: string;
  typeCode: CollectionTypeCode;
  name: string;
}

/**
 * `POST /internal/items/count` - servie par `catalog-*`, appelee par `sharing` (3.2).
 *
 * Un appel par catalog concerne, en parallele - **jamais un par entree de partage**. Le
 * monolithe notait deja que le proprietaire n'a pas ce compte, justement parce qu'il
 * couterait une requete par entree et par partage sur une liste non plafonnee : la remarque
 * est devenue un argument de conception.
 */
export interface InternalItemCountRequest {
  entries: Array<{ collectionId: string; statuses: ShareStatus[] }>;
}

export interface InternalItemCountResponse {
  /**
   * `name` voyage avec le compte pour realigner la copie denormalisee de `sharing` sans
   * appel supplementaire : la requete de comptage lit deja la collection.
   *
   * Une collection absente de la reponse a disparu cote catalog. `sharing` la traite comme
   * telle plutot que de supposer un compte nul - une entree de partage qui pointe vers une
   * collection supprimee doit se voir, pas s'afficher vide.
   */
  counts: Array<{ collectionId: string; count: number; name: string }>;
}

// --------------------------------------------------------------------------- gateway

/**
 * `PUT /internal/registry` - servie par le gateway, appelee par `catalog-*` (3.3).
 * Ecrite **en synchrone** a la creation et a la suppression d'une ressource ; idempotente.
 * Sans elle, `GET /v1/items/:id` - qui ne porte pas le type - n'est pas routable.
 */
export interface InternalRegistryUpsert {
  collections?: Array<{
    collectionId: string;
    userId: string;
    typeCode: CollectionTypeCode;
  }>;
  resources?: Array<{
    resourceId: string;
    kind: 'item' | 'node';
    collectionId: string;
  }>;
}

/**
 * `GET /internal/registry/entries?cursor=&limit=` - servie par `catalog-*`, appelee par le
 * job de reparation du registre du gateway (3.3).
 *
 * Le re-scan est **pagine et non transactionnel** : il s'execute pendant que les catalogs
 * ecrivent. Une entree creee en cours de scan peut donc etre manquee - ce n'est pas grave,
 * elle a ete enregistree en synchrone a sa creation. Ce que le job corrige, ce sont les
 * ecritures perdues, pas les ecritures concurrentes.
 */
export interface InternalRegistryEntriesPage {
  collections: Array<{
    collectionId: string;
    userId: string;
    typeCode: CollectionTypeCode;
  }>;
  resources: Array<{
    resourceId: string;
    kind: 'item' | 'node';
    collectionId: string;
  }>;
  nextCursor: string | null;
}

// --------------------------------------------------------------------------- billing

/**
 * `GET /internal/premium/:userId` - servie par `billing`, appelee par le gateway et
 * `sharing` (3.6). Le gateway la met en cache 60 s ; la fenetre pendant laquelle une
 * perte de premium n'est pas encore effective est assumee (la perte *suspend* les
 * partages, elle ne detruit rien).
 */
export interface InternalPremium {
  premium: boolean;
  source: 'grant' | 'subscription' | 'none';
  /** epoch ms ; null = pas premium OU grant permanent. */
  expiresAt: number | null;
}

// --------------------------------------------------------------------------- identity

/**
 * `POST /internal/audit` - servie par `identity`, appelee par tout service qui journalise
 * une action attribuable a un utilisateur.
 *
 * Le journal reste **unique** apres le decoupage. C'est un choix : eparpiller l'audit dans
 * huit schemas rendrait `GET /v1/me/export` dependant de huit lectures pour une donnee dont
 * l'interet est justement d'etre chronologique et complete, et priverait l'exploitation de
 * toute vue d'ensemble d'un incident.
 *
 * L'appel est **best-effort** cote appelant : un echec d'ecriture d'audit doit alerter, pas
 * faire echouer une verification d'achat ou un partage. C'etait deja la regle dans le
 * monolithe, ou `AuditLogService.record` avalait ses erreurs.
 */
export interface InternalAuditRecord {
  userId?: string | null;
  /** `auth.login` | `subscription.verify` | `share.create` | ... */
  action: string;
  target?: string | null;
  metadata?: Record<string, unknown>;
}

// --------------------------------------------------------------------------- connections

/**
 * `GET /internal/token/:userId/:provider` - servie par `connections`, appelee par `search`
 * (et par tout service a source externe). Transpose la resolution BYOT -> repli premium ->
 * mode degrade de `sources-externes.md`.
 */
export interface InternalTokenResolution {
  /**
   * `user` : jetons personnels de l'utilisateur. `fallback` : premium, l'appelant utilise
   * sa cle serveur. `none` : mode degrade, puis 403 source-token-required si rien a servir.
   */
  source: 'user' | 'fallback' | 'none';
  credentials?: {
    accessToken: string;
    refreshToken?: string;
    /** epoch ms ; 0 = jamais (OAuth 1.0a). */
    expiresAtMs: number;
    scopes: string[];
  };
}

// --------------------------------------------------------------------------- search

/**
 * Codes de source externe. Vocabulaire partage entre `search` (qui les produit) et les
 * catalogs (qui les stockent dans `Item.sources[]` et `CollectionNode.sources[]`).
 *
 * Liste reprise **telle quelle** du monolithe. `bnf`, `mangadex` et `gbooks` n'ont pas
 * d'adapter dedie : un item y reference sa notice ou son identite, et le snapshot rend la
 * reference sans `rawData`. C'est ce qui distingue « source connue sans adapter » de
 * « provider inconnu », et le contrat V1 en depend - une source sans adapter ET sans
 * `unifiedData` est un `400`.
 */
export const ITEM_SOURCE_CODES = [
  'discogs',
  'mal',
  'tmdb',
  'bnf',
  'mangadex',
  'gbooks',
] as const;
export type ItemSourceCode = (typeof ITEM_SOURCE_CODES)[number];

/**
 * Representation normalisee d'un resultat externe, telle que `search` la produit et que les
 * catalogs la recoivent dans `rawData`.
 *
 * C'est le `UnifiedItem` de `oauth/providers/types.ts` du monolithe. Il figure au contrat
 * parce qu'il **franchit desormais une frontiere de service** : un profil de type le mappe
 * vers la verite curee d'un noeud (`mapSnapshot`), et cette forme est donc un engagement
 * entre `search` et les catalogs, plus un detail interne d'adapter.
 */
export interface UnifiedItem {
  source: ItemSourceCode;
  sourceId: string;
  mediaType: CollectionTypeCode;
  title: string;
  creators: string[];
  releaseDate?: string;
  coverUrl?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  rawData: unknown;
}

/**
 * `POST /internal/sources/snapshot` - servie par `search`, appelee par `catalog-*`.
 *
 * **Route absente du tableau du 6, et ajoutee ici en connaissance de cause.** Elle est la
 * consequence directe d'une decision que le tableau ne pouvait pas anticiper : les adapters de
 * source, qui vivaient dans `oauth/providers/` du monolithe, ont suivi `search` et non
 * `connections` - parce que ce sont eux qui appellent les catalogues externes, tiennent les
 * files BullMQ et portent les cles serveur. Or `SourceSnapshotService` s'en servait pour
 * pre-remplir la verite curee d'un item ou d'un noeud a l'attachement d'une source
 * (`POST /v1/items/:id/sources`), et ce service-la appartient au catalog.
 *
 * Sans cette route, attacher une source depuis un catalog exigerait soit d'y dupliquer les
 * adapters, soit de renoncer au pre-remplissage. Les deux sont pires.
 *
 * `rawData` a `null` signifie « provider sans adapter » : la reference est conservee telle
 * quelle, ce qui est le comportement du monolithe pour `bnf`, `mangadex` et `isbn`.
 */
export interface InternalSourceSnapshotRequest {
  userId: string;
  provider: string;
  externalId: string;
}

export interface InternalSourceSnapshotResponse {
  provider: string;
  externalId: string;
  rawData: unknown | null;
  /** ISO 8601, ou `null` si aucun adapter n'a pu decrire la reference. */
  fetchedAt: string | null;
}

// --------------------------------------------------------------------------- saga RGPD

/**
 * `DELETE /internal/users/:id/data` - servie par TOUS, appelee par `identity` (3.4).
 * **Idempotente** : c'est la condition pour que le rejeu d'un job non termine soit sans
 * danger, donc pour que la saga soit reprenable. La cascade Prisma ne franchit pas une
 * frontiere de schema ; c'est cette route qui la remplace.
 */
export interface InternalDeleteUserData {
  deleted: number;
}

/** `GET /internal/users/:id/export` - servie par TOUS, appelee par `identity` (3.4). */
export interface InternalUserExportFragment {
  service: string;
  data: Record<string, unknown>;
}
