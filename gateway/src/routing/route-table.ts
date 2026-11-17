import { ServiceName } from './service-registry.service';

/**
 * Table de routage du contrat public `/v1/*`.
 *
 * **C'est le contrat vu par l'app Android**, et la contrainte du decoupage est qu'il ne
 * bouge pas (5 de architecture-microservices.md). Cette table est donc la reponse a une
 * seule question par route : quel service la sert, et qui a le droit de l'appeler. Elle
 * remplace les `@UseGuards` que le monolithe posait sur chaque controller.
 *
 * L'ordre de declaration fait foi : la premiere regle qui matche gagne. `/v1/shares/received`
 * doit donc preceder `/v1/shares/:id`, sinon `received` serait pris pour un identifiant.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Comment le service cible est determine.
 * - un nom : route fixe.
 * - `catalog:ref` : par le registre de routage, a partir de l'identifiant de la ressource (3.3).
 * - `catalog:body-type` : par le `typeCode` du corps - creation d'une collection, qui n'a
 *   pas encore d'identifiant.
 * - `catalog:scatter` : a tous les catalogs concernes, resultats fusionnes (3.7).
 */
export type RouteTarget =
  | { kind: 'service'; service: ServiceName }
  | { kind: 'catalog:ref'; via: 'collection' | 'item' | 'node'; param: string }
  | { kind: 'catalog:body-type' }
  | { kind: 'catalog:scatter' };

/**
 * Qui peut appeler.
 * - `public` : aucune identite exigee (login, callback OAuth, webhook Play).
 * - `user` : JWT valide, principal signe emis vers l'aval.
 * - `admin` : jeton d'exploitation, aucun principal utilisateur.
 */
export type RouteAuth = 'public' | 'user' | 'admin';

/**
 * Quel statut premium conditionne l'appel (voir le tableau des trois gardes dans
 * api-endpoints.md).
 * - `none` : aucun. Lire ses partages recus, rejoindre un partage, consulter son profil.
 * - `requester` : celui du requerant. Ecritures sans collection en parametre.
 * - `owner` : celui du **proprietaire** de la collection visee, meme quand le requerant est
 *   un membre - sans quoi un membre non premium ne pourrait pas lire ce qu'on lui partage.
 */
export type RoutePremium = 'none' | 'requester' | 'owner';

export interface RouteRule {
  methods: HttpMethod[];
  /** Chemin avec parametres nommes : `/v1/collections/:id/items`. */
  pattern: string;
  target: RouteTarget;
  auth: RouteAuth;
  premium: RoutePremium;
  /**
   * Ecriture visant une collection identifiable. Un **membre** d'un partage obtient alors
   * `403` et non `404` : il voit deja la ressource, un 404 mentirait sur ce qu'il lit.
   */
  write?: boolean;
  /** Surcharge de throttle, en requetes par minute. */
  rateLimitPerMin?: number;
  /**
   * Retransmettre l'en-tete `Authorization` vers l'aval.
   *
   * **Faux par defaut, et ce defaut est une regle de securite** : `Authorization` porte le
   * JWT de l'utilisateur, l'identite passe par le principal signe, et retransmettre le jeton
   * permettrait a chaque service de le rejouer ailleurs.
   *
   * Seule route a le declarer : le webhook RTDN. Google y joint un JWT OIDC **qu'il signe
   * lui-meme** et que `billing` doit verifier. Ce n'est pas un jeton Acervatim, le gateway
   * n'a aucun moyen de le valider, et le supprimer rendrait le webhook inauthentifiable -
   * donc refuse par `billing`, donc retente en boucle par Pub/Sub.
   *
   * Les routes `auth: 'admin'` retransmettent aussi, sans le declarer : voir
   * {@link forwardsAuthorization}.
   */
  forwardAuthorization?: boolean;
}

/**
 * Retransmettre `Authorization` vers l'aval pour cette regle ? Deux cas, et deux seulement.
 *
 * - La regle le declare (`forwardAuthorization`) : le webhook RTDN.
 * - La route est `auth: 'admin'`. L'en-tete n'y porte pas un JWT d'utilisateur mais
 *   `ADMIN_API_TOKEN`, que le gateway vient de verifier et que chaque service detient deja :
 *   aucun service n'apprend un secret qu'il ne connait pas. Le service le reverifie avec son
 *   propre `AdminGuard`, indispensable puisque son port reste joignable sans passer par ici.
 *   Sans cette retransmission, toute route admin repondait `401` a travers le gateway - le
 *   jeton etait verifie ici, puis retire avant d'atteindre le service.
 *
 * Decide par le **type** d'authentification et non route par route : une route admin ajoutee
 * a la table fonctionne sans qu'on ait a se souvenir de cette exception.
 */
export function forwardsAuthorization(rule: RouteRule): boolean {
  return rule.auth === 'admin' || rule.forwardAuthorization === true;
}

const svc = (service: ServiceName): RouteTarget => ({
  kind: 'service',
  service,
});

export const ROUTE_TABLE: RouteRule[] = [
  // ------------------------------------------------------------------ identity
  {
    methods: ['POST'],
    pattern: '/v1/auth/google',
    target: svc('identity'),
    auth: 'public',
    premium: 'none',
    // Meme resserrage que le monolithe : l'echange d'un id_token est la seule route
    // ou un attaquant gagne quelque chose a insister.
    rateLimitPerMin: 10,
  },
  {
    methods: ['GET'],
    pattern: '/v1/me/export',
    target: svc('identity'),
    auth: 'user',
    premium: 'none',
  },
  {
    methods: ['GET', 'DELETE'],
    pattern: '/v1/me',
    target: svc('identity'),
    auth: 'user',
    premium: 'none',
  },

  // ------------------------------------------------------------------ billing
  {
    methods: ['POST'],
    pattern: '/v1/subscriptions/verify',
    target: svc('billing'),
    auth: 'user',
    premium: 'none',
  },
  {
    methods: ['POST'],
    pattern: '/v1/admin/invitations',
    target: svc('billing'),
    auth: 'admin',
    premium: 'none',
    rateLimitPerMin: 5,
  },
  {
    methods: ['POST'],
    pattern: '/v1/invitations/redeem',
    target: svc('billing'),
    auth: 'user',
    premium: 'none',
  },
  {
    // Webhook Google Play RTDN. Hors `/v1` et hors JWT : Google ne possede pas notre
    // jeton. L'authentification est le JWT OIDC signe par Google, verifie par `billing`.
    methods: ['POST'],
    pattern: '/webhooks/google-play/rtdn',
    target: svc('billing'),
    auth: 'public',
    premium: 'none',
    // Aucun throttle : Pub/Sub retenterait en boucle sur un 429.
    rateLimitPerMin: 0,
    // Le JWT OIDC de Google doit atteindre `billing`, seul a pouvoir le verifier.
    forwardAuthorization: true,
  },

  // ------------------------------------------------------------------ connections
  {
    methods: ['GET'],
    pattern: '/v1/oauth/:provider/start',
    target: svc('connections'),
    auth: 'user',
    premium: 'none',
  },
  {
    // Callback non authentifie : l'identite est retablie par le jeton de requete en
    // attente cote provider, pas par un JWT que le navigateur ne porte pas.
    methods: ['GET'],
    pattern: '/v1/oauth/:provider/callback',
    target: svc('connections'),
    auth: 'public',
    premium: 'none',
  },
  {
    methods: ['GET'],
    pattern: '/v1/oauth',
    target: svc('connections'),
    auth: 'user',
    premium: 'none',
  },
  {
    methods: ['DELETE'],
    pattern: '/v1/oauth/:provider',
    target: svc('connections'),
    auth: 'user',
    premium: 'none',
  },
  {
    // Generalise le `/v1/sources/tmdb/token` du monolithe : la forme vaut pour toute
    // source a cle personnelle. Le LEGO n'en a aucune : `rebrickable-data` sert ses sets.
    methods: ['PUT', 'DELETE'],
    pattern: '/v1/sources/:provider/token',
    target: svc('connections'),
    auth: 'user',
    premium: 'none',
  },
  {
    methods: ['GET'],
    pattern: '/v1/sources',
    target: svc('connections'),
    auth: 'user',
    premium: 'none',
  },

  // ------------------------------------------------------------------ search
  {
    methods: ['GET'],
    pattern: '/v1/search/edition-mapping',
    target: svc('search'),
    auth: 'user',
    premium: 'none',
  },
  {
    // Editions d'une serie manga (projection des notices BnF). Sans gate premium, comme le
    // reste de la recherche : ajouter une serie en wishlist ne demande pas la synchro.
    methods: ['GET'],
    pattern: '/v1/search/editions',
    target: svc('search'),
    auth: 'user',
    premium: 'none',
  },
  {
    methods: ['GET'],
    pattern: '/v1/search/cover',
    target: svc('search'),
    auth: 'user',
    premium: 'none',
  },
  {
    methods: ['POST'],
    pattern: '/v1/search/import-jobs',
    target: svc('search'),
    auth: 'user',
    premium: 'none',
  },
  {
    methods: ['GET'],
    pattern: '/v1/search/import-jobs/:id',
    target: svc('search'),
    auth: 'user',
    premium: 'none',
  },
  {
    // Code-barres d'un jeu de societe -> BoardGameGeek (GameUPC puis BGG). Toujours sous
    // `auth: 'user'` : les donnees BGG ne se redistribuent pas par une API publique.
    methods: ['GET'],
    pattern: '/v1/search/boardgame/barcode/:code',
    target: svc('search'),
    auth: 'user',
    premium: 'none',
  },
  {
    // Choix de l'utilisateur, transmis a GameUPC sous pseudonyme. Plafond propre : un client
    // en boucle ferait voter en rafale, et c'est la cle Acervatim que GameUPC revoquerait.
    methods: ['POST'],
    pattern: '/v1/search/boardgame/barcode/:code/choice',
    target: svc('search'),
    auth: 'user',
    premium: 'none',
    rateLimitPerMin: 30,
  },
  {
    methods: ['GET'],
    pattern: '/v1/search',
    target: svc('search'),
    auth: 'user',
    premium: 'none',
  },
  {
    methods: ['GET'],
    pattern: '/v1/admin/queues',
    target: svc('search'),
    auth: 'admin',
    premium: 'none',
  },
  {
    // Tomes parus depuis l'import, par serie du requerant. Premium comme la synchro : sans
    // elle, le serveur ne connait ni ses series ni ses tomes. `search` le reverifie sur le
    // principal, pour l'appel qui ne passerait pas par ici.
    methods: ['GET'],
    pattern: '/v1/series-updates',
    target: svc('search'),
    auth: 'user',
    premium: 'requester',
  },
  {
    // Passage de rattrapage hors planification. Meme resserrage que dans le monolithe.
    methods: ['POST'],
    pattern: '/v1/admin/edition-watch/run',
    target: svc('search'),
    auth: 'admin',
    premium: 'none',
    rateLimitPerMin: 5,
  },

  // ------------------------------------------------------------------ sharing
  // `received` et `redeem` avant `:id` : sinon ils seraient pris pour des identifiants.
  {
    methods: ['GET'],
    pattern: '/v1/shares/received',
    target: svc('sharing'),
    auth: 'user',
    premium: 'none',
  },
  {
    methods: ['PATCH'],
    pattern: '/v1/shares/received/:shareId',
    target: svc('sharing'),
    auth: 'user',
    premium: 'none',
  },
  {
    // Pas de gate premium : c'est le proprietaire qui paie le stockage, pas le membre.
    methods: ['POST'],
    pattern: '/v1/shares/redeem',
    target: svc('sharing'),
    auth: 'user',
    premium: 'none',
    rateLimitPerMin: 5,
  },
  {
    methods: ['POST'],
    pattern: '/v1/shares',
    target: svc('sharing'),
    auth: 'user',
    premium: 'requester',
  },
  {
    // Lister ses partages emis reste possible sans premium : sinon un proprietaire dont
    // l'abonnement vient d'expirer ne pourrait plus voir - ni revoquer - ce qu'il partage.
    methods: ['GET'],
    pattern: '/v1/shares',
    target: svc('sharing'),
    auth: 'user',
    premium: 'none',
  },
  {
    methods: ['DELETE'],
    pattern: '/v1/shares/:id/members/:memberUserId',
    target: svc('sharing'),
    auth: 'user',
    premium: 'none',
  },
  {
    methods: ['PATCH', 'DELETE'],
    pattern: '/v1/shares/:id',
    target: svc('sharing'),
    auth: 'user',
    premium: 'none',
  },

  // ------------------------------------------------------------------ catalog
  {
    methods: ['POST'],
    pattern: '/v1/collections',
    target: { kind: 'catalog:body-type' },
    auth: 'user',
    premium: 'requester',
  },
  {
    // Multi-types : appel parallele aux catalogs, fusion et curseur composite (3.7).
    methods: ['GET'],
    pattern: '/v1/collections',
    target: { kind: 'catalog:scatter' },
    auth: 'user',
    premium: 'requester',
  },
  {
    methods: ['POST'],
    pattern: '/v1/collections/:collectionId/nodes',
    target: { kind: 'catalog:ref', via: 'collection', param: 'collectionId' },
    auth: 'user',
    premium: 'owner',
    write: true,
  },
  {
    methods: ['GET'],
    pattern: '/v1/collections/:collectionId/nodes',
    target: { kind: 'catalog:ref', via: 'collection', param: 'collectionId' },
    auth: 'user',
    premium: 'owner',
  },
  {
    methods: ['POST'],
    pattern: '/v1/collections/:collectionId/items',
    target: { kind: 'catalog:ref', via: 'collection', param: 'collectionId' },
    auth: 'user',
    premium: 'owner',
    write: true,
  },
  {
    methods: ['GET'],
    pattern: '/v1/collections/:collectionId/items',
    target: { kind: 'catalog:ref', via: 'collection', param: 'collectionId' },
    auth: 'user',
    premium: 'owner',
  },
  {
    methods: ['GET'],
    pattern: '/v1/collections/:id',
    target: { kind: 'catalog:ref', via: 'collection', param: 'id' },
    auth: 'user',
    premium: 'owner',
  },
  {
    methods: ['PATCH', 'DELETE'],
    pattern: '/v1/collections/:id',
    target: { kind: 'catalog:ref', via: 'collection', param: 'id' },
    auth: 'user',
    premium: 'owner',
    write: true,
  },
  {
    methods: ['GET'],
    pattern: '/v1/nodes/:id/sources',
    target: { kind: 'catalog:ref', via: 'node', param: 'id' },
    auth: 'user',
    premium: 'owner',
  },
  {
    methods: ['POST'],
    pattern: '/v1/nodes/:id/sources',
    target: { kind: 'catalog:ref', via: 'node', param: 'id' },
    auth: 'user',
    premium: 'owner',
    write: true,
  },
  {
    methods: ['GET'],
    pattern: '/v1/nodes/:id',
    target: { kind: 'catalog:ref', via: 'node', param: 'id' },
    auth: 'user',
    premium: 'owner',
  },
  {
    methods: ['PATCH', 'DELETE'],
    pattern: '/v1/nodes/:id',
    target: { kind: 'catalog:ref', via: 'node', param: 'id' },
    auth: 'user',
    premium: 'owner',
    write: true,
  },
  {
    methods: ['GET'],
    pattern: '/v1/items/:id/sources',
    target: { kind: 'catalog:ref', via: 'item', param: 'id' },
    auth: 'user',
    premium: 'owner',
  },
  {
    methods: ['POST'],
    pattern: '/v1/items/:id/sources',
    target: { kind: 'catalog:ref', via: 'item', param: 'id' },
    auth: 'user',
    premium: 'owner',
    write: true,
  },
  {
    methods: ['GET'],
    pattern: '/v1/items/:id',
    target: { kind: 'catalog:ref', via: 'item', param: 'id' },
    auth: 'user',
    premium: 'owner',
  },
  {
    methods: ['PATCH', 'DELETE'],
    pattern: '/v1/items/:id',
    target: { kind: 'catalog:ref', via: 'item', param: 'id' },
    auth: 'user',
    premium: 'owner',
    write: true,
  },
];
