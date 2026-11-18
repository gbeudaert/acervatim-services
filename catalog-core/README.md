# catalog-core

Le CRUD collections / noeuds / items, **mutualise par les quatre services `catalog-*`**.

Ce n'est pas un service : c'est la bibliotheque `libs/catalog-core` que l'architecture prevoit
(`../../../acervatim-docs/agent/backend/architecture-microservices.md`, 1 et 2).

---

## 1. Pourquoi elle existe

`catalog-generic`, `catalog-manga`, `catalog-vinyl` et `catalog-lego` partagent l'essentiel de
leur code. Le CRUD est identique ; ce qui differe tient dans un `itemSchema`, une
`toListProjection`, une `hierarchy` (vide pour le vinyle et le LEGO) et un `reconcileOnUpdate`
optionnel - c'est-a-dire dans un `CollectionTypeProfile`.

Le monolithe en faisait deja un point d'extension propre (`collections/types/registry.ts`), et
c'est precisement ce qui rend le decoupage par type **possible** : la frontiere existait, il
s'agissait de la faire passer du `Record` en memoire au reseau.

Recopier ce CRUD dans chaque catalog creerait exactement la divergence que le decoupage cherche
a eviter : plusieurs implementations du meme code, qui derivent au premier correctif applique
d'un seul cote. C'est pour cela que `catalog-lego`, d'abord ecrit comme une stack autonome, a ete
refait sur cette bibliotheque le 2026-11-17 au lieu de garder son propre code.

Resultat : un service catalog se reduit a trois choses - son schema Prisma, son socle
technique, et un fichier `profiles.ts` de dix lignes.

---

## 2. Comment elle est compilee - le point non evident

**Elle n'est pas un paquet npm compile. Elle est compilee DANS son consommateur.**

La raison est Prisma : `catalog-core` manipule `Collection`, `CollectionNode` et `Item`, dont
les types sont **generes** par chaque service depuis son propre `schema.prisma`. Une
bibliotheque pre-compilee devrait choisir un client ; compilee dans le consommateur, elle est
typee contre le sien. Les catalogs ayant des modeles identiques, le meme code type-checke
contre tous.

Concretement :

```
catalog-manga/
  catalog-core/     <- jonction vers ../catalog-core (hote) / copie (conteneur)
  src/
    profiles.ts     import { mangaProfile } from '../catalog-core/src';
  tsconfig.json     include: ["src/**/*", "catalog-core/src/**/*"]
```

Trois consequences a connaitre :

- **Import relatif, pas d'alias.** `../catalog-core/src` resout a la compilation comme a
  l'execution (`dist/src/*.js` -> `dist/catalog-core/src/*.js`). Un alias `paths` serait plus
  joli mais ne serait pas reecrit par `tsc` : il faudrait `tsconfig-paths` au demarrage, donc
  de la magie a l'execution pour un gain cosmetique.
- **`"paths": { "*": ["node_modules/*"] }`** dans le tsconfig du service. Sans lui, TypeScript
  chercherait `@nestjs/common` depuis `catalog-core/`, qui n'a pas de `node_modules`. A
  l'execution le probleme ne se pose pas : `dist/catalog-core/src/*.js` remonte naturellement
  vers `/app/node_modules`.
- **`dist/` est decale d'un cran** pour les catalogs : `dist/src/main.js` au lieu de
  `dist/main.js`, la racine de compilation etant `/app` et non `/app/src`. D'ou
  `"entryFile": "src/main"` et `"start:prod": "node dist/src/main"`.

Sur l'hote, la jonction se recree par `../scripts/dev.ps1 link-core`. Elle est ignoree par git :
dans le conteneur, c'est le `COPY` du Dockerfile qui met le dossier au meme endroit.

---

## 3. Ce qu'elle contient - et ce qu'elle ne contient pas

**Elle contient** : le domaine. Services et controleurs `collections` / `items` / `nodes`, leurs
DTO, les profils de type, le filtrage par statut de partage, les plafonds techniques, les routes
`/internal/*` du catalog, et les clients qui parlent au gateway (registre) et a `search`
(snapshot de source).

**Elle ne contient pas** : le socle technique. Gardes, filtre RFC 9457, journal d'acces, client
HTTP interne, `PrismaService` restent dans chaque service. Cette bibliotheque n'est pas un
second socle - elle recoit du service ce dont elle a besoin :

| Injection | Fournie par le service |
|---|---|
| `CATALOG_DB` | son `PrismaService` |
| `INTERNAL_TRANSPORT` | son `InternalClientService` |
| `CATALOG_CONFIG` | les URLs du gateway et de `search` |
| `COLLECTION_TYPE_PROFILES` | son `profiles.ts` |

---

## 4. Ce que le decoupage a change dans ce code

Le CRUD est celui du monolithe. Quatre points ont bouge, tous documentes sur place :

- **`typeCode` remplace `typeId`.** La FK pointait `collection_types`, qui appartient desormais
  a `identity`. Le code stable est stocke en clair : une FK inter-schemas de moins, et une
  jointure de moins sur chaque lecture. La reponse de l'API ne change pas - elle exposait deja
  le code.
- **`ShareFilterService` a change de service.** Il vivait dans `sharing/` et y etait injecte
  dans le domaine collection ; il est maintenant **ici**, ou il filtre sur les tables locales.
  C'est l'inversion du 3.1, et elle marche parce que le `status` d'un item vit dans son
  `userData`, donc chez le catalog.
- **`CollectionAccess` n'est plus resolu, il est lu.** Le gateway le resout une fois aupres de
  `sharing` et le propage dans le principal signe. L'invariant qui comptait est meme renforce :
  les statuts arrivent dans un jeton signe HMAC, que le client ne peut ni forger ni modifier.
- **Le snapshot de source est un appel reseau.** Les adapters ont suivi `search` ; le catalog
  les interroge par `POST /internal/sources/snapshot`. La forme du resultat est inchangee, y
  compris la distinction `rawData: null` qui porte une regle du contrat V1.

---

## 5. Ce qui n'a pas change, et qu'il ne faut pas defaire

- **`unifiedData` est remplace en bloc**, sauf ce que le profil decide de preserver
  (`reconcileOnUpdate`). C'est ce qui empeche un client qui modelise un champ moins finement
  que le serveur de le degrader a chaque synchronisation - le cas du `releaseDate` vinyle.
- **`userData` est merge**, pas remplace : semantique PATCH.
- **Ni serie ni numero de tome ne sont exiges** sur un type hierarchique. Supprimer une serie
  laisse ses tomes orphelins, un hors-serie n'a pas de numero : les refuser ferait de la
  synchronisation une perte de donnees, pas un miroir.
- **`nodeId` hors de la collection visee = `404`, jamais `400`.** Meme regle qu'en lecture : pas
  d'oracle d'existence.
- **Un noeud vide et non desire est purge** quand son dernier tome part.
- **Les compteurs d'un membre sont recalcules** sous les statuts exposes. La colonne
  denormalisee compterait la collection entiere et afficherait « 240 elements » sur une vue qui
  en montre 12.

---

## 6. Tests

Deux niveaux, tous deux dans cette bibliotheque, et tous deux executes **dans un catalog** :
comme le reste du code, ils sont compiles contre le client Prisma du catalog qui les lance.

**Unitaires** (`src/**/*.spec.ts`) : profils de type, `userData` d'un item, visibilite sous des
statuts de partage et `userData` rendu a un membre, plafonds techniques. Ils tournent avec les
tests de chaque catalog (`./scripts/dev.ps1 test <catalog>`) : la configuration Jest des catalogs
liste `catalog-core/src` dans ses `roots`.

**Integration** (`test/*.int-spec.ts`), contre une vraie base MariaDB :
`./scripts/dev.ps1 test-int <catalog>`. La base est celle du catalog suffixee `_it`
(`acv_cat_manga_it`...), recreee et migree a chaque execution ; le nom est verifie avant tout
nettoyage. Le harnais (`test/harness.ts`) monte le vrai domaine - controleurs, services, gardes,
validation Zod, client Prisma - et ne simule que ce qui vient d'ailleurs : le principal (un
en-tete de test en clair, au lieu du principal signe du gateway) et les voisins (registre du
gateway, snapshots de `search`). C'est elle qui execute les requetes SQL ecrites a la main :
filtres `items[in]`/`items[all]`, `provider[in]`, statuts de partage, comptages.

| Fichier | Equivalent dans le monolithe |
|---|---|
| `test/items.int-spec.ts` | `items/items.e2e.spec.ts` (hors gate premium), `items/items.service.spec.ts`, `nodes/nodes.service.spec.ts` |
| `test/collections.int-spec.ts` | `collections/collections.service.spec.ts` |
| `test/shared-read.int-spec.ts` | `sharing/shared-read.e2e.spec.ts`, partie catalog |
| `test/internal.int-spec.ts` | routes `/internal/*` (nouvelles) et plafonds sur une vraie base |
| `src/types/profiles.spec.ts`, `src/types/lego.spec.ts` | `collections/types/profiles.spec.ts` |
| `src/item-user-data.schema.spec.ts` | `items/dto/item-user-data.schema.spec.ts` |
| `src/share-filter.spec.ts` | `sharing/share-filter.service.spec.ts`, partie catalog |
| `src/limits.service.spec.ts` | `common/limits/limits.service.spec.ts` |

Ce qui a quitte les catalogs se teste ailleurs : le gate premium, la resolution d'acces et le
refus d'un identifiant malforme dans le gateway (`principal/principal.service.spec.ts`), la
resolution d'acces, les partages et les ensembles de statuts dans `sharing` (sa suite
d'integration, `test-int sharing`, et `share-statuses.spec.ts`), le decodage du principal signe
dans chaque service (`principal.codec.spec.ts`).

Deux comportements a connaitre, fixes par les tests :

- **Le catalog ne redecide pas le partage, mais il verifie la propriete.** Il lit le role et
  les statuts du principal signe sans consulter `sharing`. Un principal qui n'est pas marque
  `shared` doit en revanche etre le proprietaire de la collection visee, sinon `404` : c'est
  une defense en profondeur (decision du 2026-11-18), le gateway ayant deja refuse ce tiers.
  Les ecritures restent en plus scopees sur l'utilisateur dans les services (404).
- **Un identifiant malforme rend 404 au catalog seul**, parce que le garde d'acces cherche la
  ressource avant la validation du parametre. Le gateway rend 400 en amont, comme le monolithe.

---

## 7. Reste a faire

- **Arbitrer les plafonds techniques (3.5).** Ils comptaient par utilisateur a travers toutes
  ses collections ; chaque catalog ne voit desormais que les siennes, donc un utilisateur
  multi-types peut atteindre jusqu'a N fois le plafond unitaire. C'est assume et documente dans
  `limits.service.ts`, mais le chiffre n'a pas ete rediscute.
- **Le jour ou un type de `catalog-generic` merite un vrai profil**, il se declare dans son
  `profiles.ts` ; s'il devient assez lourd pour justifier son propre processus, il quitte ce
  fichier pour un service a lui, sans que ce CRUD bouge.
