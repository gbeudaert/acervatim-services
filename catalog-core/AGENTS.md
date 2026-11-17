## @acervatim/catalog-core

Le CRUD collections / noeuds / items, mutualise par `catalog-generic`, `catalog-manga`,
`catalog-vinyl` et `catalog-lego`. **Ce n'est pas un service** : c'est le `libs/catalog-core` de
`../../../acervatim-docs/agent/backend/architecture-microservices.md`.

## Policy

- **Ne jamais forker ce code dans un catalog.** C'est la raison d'etre du dossier : plusieurs
  copies du meme CRUD divergeraient au premier correctif applique d'un seul cote. Un besoin
  specifique a un type se traite par son `CollectionTypeProfile`, pas par une branche ici.
- **Cette bibliotheque ne connait pas l'arborescence de son consommateur.** Elle ne doit rien
  importer de `src/` d'un service : ce dont elle a besoin lui est **injecte** (`CATALOG_DB`,
  `INTERNAL_TRANSPORT`, `CATALOG_CONFIG`, `COLLECTION_TYPE_PROFILES`).
- **Aucune `@relation` Prisma ne franchit la frontiere du schema `acv_cat_*`.** Les relations
  qui restent - collection -> noeuds -> items - sont intra-schema et survivent au decoupage.
- **Aucun garde premium ici.** Les trois gardes du monolithe sont au gateway (3.6). En ajouter
  un ferait decider deux endroits du meme acces, qui finiraient par ne plus dire la meme chose.
- Ne nommer aucun materiel ni hebergeur dans le code ou un commentaire.
- Toute la documentation de conception va dans `../../../acervatim-docs`. Ici : README + AGENTS.md.
- Pas de nouvelle dependance sans accord prealable.

## Where things are

- `src/types/` : les profils de type. **Le seul endroit ou un catalog differe d'un autre.**
- `src/share-filter.service.ts` : le filtrage par statut de partage, venu de `sharing/` avec
  l'inversion du 3.1.
- `src/access.ts` : `CollectionAccess`, desormais **lu** depuis le principal signe et non
  resolu.
- `src/clients/` : registre de routage (gateway) et snapshot de source (`search`).
- `src/internal/` : les routes `/internal/*` du catalog (owner, comptage, re-scan, RGPD, noeuds
  par type et niveau pour le rattrapage manga de `search`).
- `src/contracts.ts` : copie du contrat inter-services, comme dans chaque service.

## Running and verifying

- Cette bibliotheque **ne se compile pas seule** : elle est compilee dans un catalog, contre le
  client Prisma que celui-ci a genere. Pour la verifier :
  `../scripts/dev.ps1 build-ts catalog-manga` (ou `test catalog-manga`).
- Sur l'hote, la jonction `catalog-*/catalog-core` se recree par
  `../scripts/dev.ps1 link-core`. Sans elle, l'editeur ne resout pas les imports.
- Une modification ici affecte **les quatre catalogs** : les type-checker tous avant
  de conclure (`../scripts/dev.ps1 build-ts` sans argument).
- Tests unitaires (`src/**/*.spec.ts`) : ils tournent avec ceux de chaque catalog
  (`../scripts/dev.ps1 test <catalog>`). Suite d'integration (`test/*.int-spec.ts`), contre la
  base `<schema du catalog>_it`, recreee a chaque execution :
  `../scripts/dev.ps1 test-int <catalog>`. Une modification du CRUD ou d'une requete SQL se
  verifie par cette suite, pas seulement par les tests unitaires. Detail : README, 6.

## Conventions that differ from defaults

- **Import relatif depuis le service** (`../catalog-core/src`), pas d'alias `paths` : `tsc` ne
  reecrit pas les alias, et un alias imposerait `tsconfig-paths` au demarrage.
- **`dist/` est decale d'un cran** pour les catalogs (`dist/src/main.js`), la racine de
  compilation etant `/app`. D'ou `entryFile: "src/main"`.
- Les DTO sont a `src/<domaine>/dto/` : la racine de la bibliotheque est **deux** crans plus
  haut (`../../contracts`), pas un. Une erreur de profondeur y fait silencieusement tomber les
  types Zod en `{}` - le symptome apparait loin de la cause, dans les services.
- Validation par Zod via `nestjs-zod` (`createZodDto`) - pas de `class-validator`.
- Pas d'emoji dans le code ni dans les messages de commit.

## Known pitfalls

- **L'ordre `(createdAt desc, id desc)` de `CollectionsService.list` est partage avec le
  scatter-gather du gateway** (3.7). Le changer d'un seul cote casse la fusion multi-catalogs -
  en silence : une pagination qui saute ou duplique des lignes ne leve aucune erreur.
- **Le registre de routage s'ecrit hors transaction, et son echec ne fait pas echouer
  l'ecriture.** Ne pas « durcir » en annulant la creation : le domaine collection deviendrait
  indisponible des que le gateway hoquette. Le job de reparation nocturne existe pour ca.
- **`purgeNodeIfEmpty` rend `true` quand il a supprime** : l'appelant doit desenregistrer le
  noeud. Ignorer ce retour laisse une entree orpheline dans le registre.
- **Un profil de type absent retombe sur le profil permissif**, il ne leve pas. Le vrai
  garde-fou contre un mauvais routage est le registre du gateway, pas ce repli.
- **Les middlewares des catalogs s'accrochent aux controleurs** (`CATALOG_PUBLIC_CONTROLLERS`,
  `CATALOG_INTERNAL_CONTROLLERS`), jamais a un motif de chemin. `forRoutes({ path: 'v1/(.*)' })`
  recoit le prefixe global une seconde fois, et Express 4 lit `internal/(.*)` comme « un point,
  puis n'importe quoi » : aucun des deux ne s'appliquait, et les routes `/internal/*` - export et
  suppression RGPD compris - repondaient sans jeton. Corrige le 2026-11-02.
- **Dans le conteneur de dev, `/app/catalog-core` est un lien symbolique** (la jonction de
  `link-core`, montee). Jest ne suit pas les liens en cherchant les tests : d'ou les `roots` des
  catalogs et de `test/jest-int.config.js`. TypeScript resout alors les types depuis le chemin
  reel, hors du catalog : d'ou `node_modules/@types/*` dans les `paths` des tsconfig. Et un
  script de test ne doit jamais partir de `__dirname` pour trouver le catalog.
- PowerShell 5.1 : ni `&&` ni `||` (utiliser `; if ($?) { ... }`). Sources `.ps1` en ASCII pur.
