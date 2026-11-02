## acervatim-catalog-generic

Catalogue des collections de types movie, book et game (NestJS, Prisma, MariaDB). Schema `acv_cat_generic`, port 3160. Cible :
`../../../acervatim-docs/agent/backend/architecture-microservices.md`.

## Policy

- **Ne rien ecrire de metier ici.** Tout le CRUD vient de `../catalog-core`. Un besoin
  specifique a un type se traite par son `CollectionTypeProfile`, jamais par du code ajoute
  dans ce service : trois copies du meme CRUD divergeraient au premier correctif.
- **Aucun garde premium.** Les trois gardes du monolithe sont au gateway (3.6). En rajouter un
  ferait interroger `billing` deux fois par requete et decider deux fois du meme acces.
- **Aucune `@relation` Prisma ne franchit la frontiere du schema `acv_cat_generic`.** `userId` reste
  une colonne nue ; `typeCode` remplace la FK vers `collection_types`, qui appartient a
  `identity`.
- **Le schema Prisma est identique dans les trois catalogs.** C'est ce qui permet a
  `catalog-core` d'etre compile contre les trois clients generes. Le modifier ici seul casse
  les deux autres, a la compilation - donc bruyamment, ce qui est le bon mode de defaillance.
- Ne nommer aucun materiel ni hebergeur dans le code ou un commentaire.
- Toute la documentation de conception va dans `../../../acervatim-docs`. Ici : README + AGENTS.md.
- Pas de nouvelle dependance sans accord prealable.

## Where things are

- `src/profiles.ts` : **le seul fichier qui distingue ce service des deux autres catalogs.**
- `catalog-core/` : jonction (hote) ou copie (conteneur) vers la bibliotheque partagee. Voir
  son README pour la mecanique de compilation - elle n'est pas evidente.
- `src/common/` : le socle, identique a celui des autres services.
- `src/common/guards/*.middleware.ts` : `PrincipalMiddleware` et `InternalTokenMiddleware`. Des
  middlewares et non des gardes, parce que les controleurs viennent de `catalog-core` et qu'on
  ne peut pas decorer un handler qu'on ne declare pas.

## Running and verifying

- Tout passe par le wrapper de la racine : `../scripts/dev.ps1 up-bg`,
  `../scripts/dev.ps1 logs catalog-generic`, `../scripts/dev.ps1 test catalog-generic`.
- **`../scripts/dev.ps1 link-core` une fois** apres un clone : sans la jonction, l'editeur ne
  resout pas `../catalog-core/src` et la compilation echoue sur l'hote.
- `npm`, `npx`, `node`, `prisma`, `nest` ne se lancent **jamais** depuis Windows : passer par
  `../scripts/dev.ps1 <cmd> catalog-generic`.
- Une modification de `catalog-core` affecte **les trois catalogs** : les type-checker tous
  (`../scripts/dev.ps1 build-ts`) avant de conclure.
- **`docker compose restart` ne relit pas `.env`.** Apres modification, utiliser
  `docker compose up -d --force-recreate catalog-generic`.

## Conventions that differ from defaults

- **`dist/` est decale d'un cran** : `dist/src/main.js`, pas `dist/main.js`. La racine de
  compilation est `/app` parce que `catalog-core/` en fait partie. D'ou `entryFile: "src/main"`.
- **`"paths": { "*": ["node_modules/*"] }`** dans le tsconfig : sans lui, les imports nus
  ecrits dans `catalog-core/` seraient cherches depuis un dossier sans `node_modules`.
- Authentification par `PrincipalGuard` (via middleware), pas par un `JwtAuthGuard`.
- Validation par Zod via `nestjs-zod` (`createZodDto`) - pas de `class-validator`.
- Erreurs RFC 9457 sous les **memes URI `type`** que le monolithe.
- Pas d'emoji dans le code ni dans les messages de commit.

## Known pitfalls

- **Un catalog qui ne s'enregistre pas aupres du gateway cree des ressources introuvables.**
  `GET /health/ready` expose `registry` pour cette raison ; un `404` sur une ressource qui
  existe est le symptome le plus difficile a diagnostiquer de toute la cible (3.3).
- **L'ordre `(createdAt desc, id desc)` est partage avec le scatter-gather du gateway** (3.7).
  Le changer d'un seul cote casse la fusion multi-catalogs sans lever d'erreur.
- **Le profil permissif n'est pas une absence de validation** : `unifiedData` reste borne en
  taille (`UNIFIED_DATA_MAX_BYTES`) et `status`/`playCount` restent projetes en liste. Un type
  qui gagne un vrai profil ne doit pas perdre ces garanties au passage.
- PowerShell 5.1 : ni `&&` ni `||` (utiliser `; if ($?) { ... }`). Sources `.ps1` en ASCII pur.
