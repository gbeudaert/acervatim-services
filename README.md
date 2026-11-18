# backend-services

La constellation micro-services d'Acervatim : le decoupage de `acervatim-backend` decrit dans
`../../acervatim-docs/agent/backend/architecture-microservices.md`.

**L'app Android n'est pas touchee.** C'est la contrainte, pas un objectif secondaire : le
gateway conserve `/v1/*`, les Problem Details RFC 9457 sous les memes URI `type`, la pagination
cursor et les codes de refus documentes dans `api-endpoints.md`.

---

## 1. La carte

```
App Android ──HTTPS──> gateway  (/v1/*, JWT, routage, agregation OpenAPI, debit)
                          │
                          │  HTTP interne + principal signe X-Acervatim-Principal
     ┌─────────────┬─────────────┬──────┴──────┬─────────────────┬──────────┬──────────┐
 catalog-manga  catalog-vinyl  catalog-lego  catalog-generic  sharing    search   connections
     └───────────── identity (auth/users/RGPD/audit) ── billing (premium/subs/invit.)

 rebrickable-data (catalogue LEGO de reference) : hors gateway, /internal/* et /admin/* seulement,
 lu par search pour la recherche LEGO
```

| Service | Port | Schema | Perimetre |
|---|---|---|---|
| [`gateway`](gateway/) | 3100 | `acv_gateway` | Point d'entree `/v1/*`, principal signe, registre de routage, scatter-gather |
| [`identity`](identity/) | 3110 | `acv_core` | Auth, `/v1/me`, **saga RGPD**, journal d'audit |
| [`billing`](billing/) | 3120 | `acv_billing` | Premium (source de verite), Google Play, invitations |
| [`connections`](connections/) | 3130 | `acv_conn` | OAuth externe, cles personnelles, resolution de jeton |
| [`sharing`](sharing/) | 3140 | `acv_sharing` | Partages, membres, **resolution d'acces** |
| [`search`](search/) | 3150 | `acv_search` | Recherche externe, files BullMQ, cache d'API |
| [`catalog-generic`](catalog-generic/) | 3160 | `acv_cat_generic` | movie, book, game |
| [`catalog-manga`](catalog-manga/) | 3170 | `acv_cat_manga` | manga |
| [`catalog-vinyl`](catalog-vinyl/) | 3180 | `acv_cat_vinyl` | vinyle |
| [`rebrickable-data`](rebrickable-data/) | 3190 | `acv_rebrickable` | Catalogue LEGO de reference (CSV Rebrickable, codes-barres Brickset au scan) - **interne**, non route par le gateway, lu par `search` |
| [`catalog-lego`](catalog-lego/) | 3220 | `acv_cat_lego` | LEGO (un item est une boite) |
| [`catalog-core`](catalog-core/) | - | - | **Bibliotheque** : le CRUD mutualise par les quatre catalogs |
| [`deploy`](deploy/) | - | - | **Deploiement** : Quadlet Podman, manifeste Kubernetes, images de production |

**Une seule instance MariaDB, un schema logique par service, aucune FK inter-schemas.** C'est
la decision actee du 7, et elle est la source de presque tout le travail decrit ci-dessous.

**Brickset, au scan seulement.** `rebrickable-data` n'appelle Brickset que pour un code scanne
absent de son cache (decision du 2026-11-16) ; il n'y a plus de moissonnage.
`BRICKSET_API_KEY` n'est lue **que** par `rebrickable-data` : `catalog-lego` n'appelle ni
Rebrickable ni Brickset, et n'a aucune cle. Voir `.env.example` et
[rebrickable-data](rebrickable-data/README.md#22-brickset-au-scan).

**Perimetre du deploiement.** Onze services sont declares dans `deploy/` : tous ceux du tableau
sauf `catalog-core` (une bibliotheque). `catalog-lego` a ete refait sur `catalog-core` le
2026-11-17, comme clone de `catalog-vinyl`, pour etre en place a la bascule. En production,
`BRICKSET_API_KEY` reste absente tant que l'accord de Brickset n'est pas obtenu. Detail :
[`deploy/README.md`](deploy/README.md#8-lego--deux-services).

---

## 2. Demarrage

```powershell
Copy-Item .env.example .env        # puis remplir (les cles obligatoires sont commentees)
./scripts/dev.ps1 link-core        # une fois : jonction catalog-*/catalog-core
./scripts/dev.ps1 build
./scripts/dev.ps1 up-bg
./scripts/dev.ps1 health
```

Un seul `.env` pour toute la stack, et c'est delibere : les secrets partages - JWT, principal
signe, peppers - doivent avoir la **meme valeur partout**, ce qu'un fichier unique garantit par
construction. `docker-compose.yml` surcharge par service ce qui doit differer (port, base, URLs
des voisins).

Ports decales (3100+, 3320, 6390) pour cohabiter avec le monolithe (3000/3306/6379).

`./scripts/dev.ps1 help` liste le reste. `npm`, `npx`, `prisma` et `nest` ne se lancent
**jamais** depuis Windows : un lancement hote produit des artefacts Prisma inutilisables dans
le conteneur.

Pour le **deploiement** (Podman rootless, Quadlet systemd, un pod applicatif derriere une base
et un Redis autonomes) : [`deploy/README.md`](deploy/README.md).

---

## 3. Les sept coutures, et ou elles ont ete recousues

Le chantier n'etait pas le decoupage : c'est la rupture des coutures que le monolithe tenait
gratuitement. Voici ou chacune a atterri.

| Couture | Reponse | Ou lire le detail |
|---|---|---|
| **3.1** `sharing` injecte dans le domaine collection, dans les deux sens | Inversion : `sharing` rend `{ role, statuses }`, le catalog filtre chez lui | [sharing](sharing/README.md#1-la-couture-la-plus-dure-du-decoupage-passe-ici-31) |
| **3.2** `itemCount` des partages recus | `POST /internal/items/count` - un appel par catalog, jamais un par entree | [sharing](sharing/README.md#3-itemcount-null-nest-pas-itemcount-0) |
| **3.3** Routage `collectionId -> typeCode` | Registre dans `acv_gateway`, ecrit en synchrone, **plus son job de reparation** | [gateway](gateway/README.md#22-le-registre-de-routage-et-pourquoi-son-job-de-reparation-existe-des-maintenant-33) |
| **3.4** Cascade RGPD | Saga orchestree par `identity`, participants idempotents, rejeu et alerte | [identity](identity/README.md#2-la-saga-de-suppression-34---le-point-a-risque-juridique-du-chantier) |
| **3.5** Plafonds techniques | Plafond par catalog, ecart assume et documente | [catalog-core](catalog-core/README.md) |
| **3.6** Premium sur le chemin chaud | Principal signe emis par le gateway, cache Redis 60 s, invalide par `billing` | [gateway](gateway/README.md#21-le-principal-signe-remplace-trois-gardes-36) |
| **3.7** `GET /v1/collections` multi-types | Scatter-gather et **curseur composite** | [gateway](gateway/README.md#23-le-scatter-gather-et-son-curseur-composite-37) |

Deux decisions ont ete prises **au-dela** du tableau du 6, parce que le decoupage les a rendues
necessaires ; elles sont argumentees dans `common/internal/contracts.ts` :

- `POST /internal/sources/snapshot` (`search` -> catalogs) : les adapters de source ont suivi
  `search`, mais le pre-remplissage d'un item appartient au catalog ;
- `POST /internal/audit` (tous -> `identity`) : le journal reste unique, sinon
  `GET /v1/me/export` dependrait de huit lectures pour une donnee dont l'interet est d'etre
  chronologique et complete.

---

## 4. Ce qui est identique partout, et pourquoi

Quatre fichiers sont **volontairement dupliques a l'identique** dans chaque service :

| Fichier | Raison |
|---|---|
| `src/common/internal/contracts.ts` | C'est le `libs/contracts` de la cible. Le monorepo Nest n'existe pas encore ; en attendant, la seule discipline qui tienne est de le modifier **partout du meme coup**. |
| `src/common/filters/problem-details.filter.ts` | Le gateway relaie le corps tel quel : l'espace de noms des URI `type` doit etre strictement le meme, y compris pour des erreurs qu'un service donne ne levera jamais. |
| `src/common/errors/index.ts` | Le vocabulaire que le filtre ci-dessus reconnait. |
| `src/common/health/readiness.ts` | La sonde de disponibilite doit dire la meme chose partout : `503` si la base manque ou se tait plus de 2 s, `degraded` (et `200`) pour une dependance secondaire. La bascule et le gateway la lisent de la meme facon sur chaque service. |

`oauth1.ts` est duplique entre `connections` (qui signe le flux) et `search` (qui signe les
appels) pour la meme raison de fond : l'invariant du 1 interdit une dependance directe entre
deux `apps/`, et quatre-vingts lignes de RFC figee valent mieux qu'un couplage qui rendrait le
decoupage cosmetique.

**`catalog-core` est l'exception**, et c'est un choix inverse : le CRUD collections / noeuds /
items est trop gros et trop vivant pour etre triplique. Il est donc compile dans chacun des
quatre catalogs depuis une source unique - voir [son README](catalog-core/README.md), la
mecanique n'est pas evidente.

---

## 5. Ou sont passes les gardes

C'est le changement le plus visible en lisant le code d'un service aval : **il n'y a plus de
garde premium nulle part sauf au gateway**.

| Monolithe | Maintenant |
|---|---|
| `JwtAuthGuard` par module | `PrincipalGuard` : principal signe, JWT en repli autonome |
| `PremiumGuard` | Table de routage du gateway, `premium: 'requester'` |
| `CollectionPremiumGuard` + `@CollectionRef` | Gateway, `premium: 'owner'` |
| `CollectionWriteGuard` + `@CollectionRef` | Gateway, `write: true` |
| `@Throttle` / `@SkipThrottle` | `rateLimitPerMin` dans la table de routage |

Les codes de refus n'ont pas bouge : `404` pour un non-membre, `403` pour un membre en
ecriture, `402` pour un proprietaire non premium, `400` pour un identifiant malforme.

Chaque service garde un throttler local a 200/min - un filet contre un appel direct depuis le
reseau interne, pas la limitation principale.

---

## 6. Etat, et ce qui reste a faire

**Ce qui est fait** : les dix services compilent, leurs tests unitaires passent, et le contrat
`/v1/*` est couvert de bout en bout par la table de routage du gateway. `rebrickable-data`, qui
n'a pas de route `/v1/*`, a en plus tourne contre la vraie base : import complet des CSV
Rebrickable, puis `unchanged` au second passage.

**Ce qui ne l'est pas, et qui compte** :

- **Les migrations n'ont tourne qu'en developpement.** Ecrites a la main, pas generees par
  `migrate dev`, elles se sont appliquees sans erreur au premier `up-bg` (2026-11-02), et le
  parcours manga est passe de bout en bout a travers le gateway. Rien n'a encore tourne sous
  Podman.
- **La bascule exige une reprise des donnees**, sinon le proxy servirait des schemas vides :
  [`db/reprise/`](db/reprise/README.md) (`acv_rebrickable` excepte, qui n'a rien a reprendre et
  se remplit par l'import des CSV). Elle a ete repetee en developpement, jamais sur un
  vidage de production - c'est cette repetition qui dira la duree de la fenetre.
- **Aucune mesure du 4 n'a ete produite** : RSS total au repos, p95 de `GET /v1/collections` et
  de `GET /v1/collections/:id/items`, ecart du registre apres re-scan, jobs RGPD non termines.
  L'architecture demande explicitement de **mesurer et non de supposer** avant chaque palier -
  et ce decoupage a saute directement de M0 a M6.
- **La saga RGPD n'a pas ete eprouvee en panne reelle.** Le 3.4 est clair : tant que le rejeu
  et l'alerte n'ont pas ete observes sur un participant eteint, ce jalon n'est pas termine.
  C'est le point a risque juridique du chantier.
- **Les tests du CRUD catalog et de sharing sont portes, mais n'ont tourne qu'en
  developpement** : unitaires, et suites d'integration contre une vraie base
  (`./scripts/dev.ps1 test-int <catalog>` ou `test-int sharing`, base `<schema>_it`). Detail et
  correspondance avec les tests du monolithe : [`catalog-core`](catalog-core/README.md#6-tests),
  [`sharing`](sharing/README.md#7-tests).
- **La reserve du TL;DR de l'architecture reste entiere.** Le domaine tient en ~13 000 LOC
  servies a un unique client Android ; dix processus Node/Nest representent de l'ordre de 1,1 a
  1,5 Go de RSS au repos. Le phasage etait concu pour etre **arretable a chaque palier** - ce
  code livre la cible complete, il ne dit pas qu'il faut la deployer.
