## acervatim-catalog-lego

Catalogue des collections de type LEGO (NestJS, Prisma, MariaDB). Schema `acv_cat_lego`, port 3220.
Clone de `catalog-vinyl` sur `catalog-core`, refait le 2026-11-17 (action C7). Conception :
`../../../acervatim-docs/_bmad-output/implementation-artifacts/spec-collection-lego.md`.

## Policy

- **Ne rien ecrire de metier ici.** Tout le CRUD vient de `../catalog-core`. Un besoin
  specifique au LEGO se traite par son `CollectionTypeProfile` (`catalog-core/src/types/lego.ts`),
  jamais par du code ajoute dans ce service.
- **Ce service n'appelle ni Rebrickable ni Brickset, et n'a aucune cle de source.** Le catalogue
  des sets est dans `rebrickable-data`, seul a lire les CSV Rebrickable et seul a appeler
  Brickset, au scan. La recherche passe par `search` (`GET /v1/search?type=lego`). Ne pas
  reintroduire d'index local, de moissonneur ni de cle personnelle : c'est ce que l'ancienne
  stack faisait, et ce qui a ete supprime.
- **Aucun garde premium.** Les gardes sont au gateway (3.6).
- **Aucune `@relation` Prisma ne franchit la frontiere du schema `acv_cat_lego`.**
- **Le schema Prisma et la migration init sont identiques a ceux des autres catalogs, octet
  pour octet.** C'est ce qui permet a `catalog-core` d'etre compile contre tous les clients
  generes.
- **Les identifiants externes vont dans `sources[]`**, jamais dans `unifiedData` : numero
  canonique Rebrickable (`provider: 'rebrickable'`), code-barres (`provider: 'barcode'`).
- Ne nommer aucun materiel ni hebergeur dans le code ou un commentaire.
- Toute la documentation de conception va dans `../../../acervatim-docs`. Ici : README + AGENTS.md.
- Pas de nouvelle dependance sans accord prealable.

## Where things are

- `src/profiles.ts` : **le seul fichier qui distingue ce service des autres catalogs.**
- `src/profiles.spec.ts` : les tests du profil `lego`, qui vit dans `catalog-core`.
- `catalog-core/` : jonction (hote) ou copie (conteneur) vers la bibliotheque partagee.
- `src/common/` : le socle, identique a celui des autres services.

## Running and verifying

- Tout passe par le wrapper de la racine : `../scripts/dev.ps1 up-bg`,
  `../scripts/dev.ps1 logs catalog-lego`, `../scripts/dev.ps1 test catalog-lego`.
- **`../scripts/dev.ps1 link-core` une fois** apres un clone.
- `npm`, `npx`, `node`, `prisma`, `nest` ne se lancent **jamais** depuis Windows : passer par
  `../scripts/dev.ps1 <cmd> catalog-lego`.
- Une modification de `catalog-core` affecte **tous les catalogs** : les type-checker tous
  (`../scripts/dev.ps1 build-ts`) avant de conclure.

## Conventions that differ from defaults

Les memes que `catalog-vinyl` (voir son AGENTS.md) : `dist/src/main.js`, `paths` du tsconfig,
`PrincipalGuard` par middleware, Zod via `nestjs-zod`, erreurs RFC 9457, pas d'emoji.

## Known pitfalls

- **Un catalog qui ne s'enregistre pas aupres du gateway cree des ressources introuvables.**
  `GET /health/ready` expose `registry` pour cette raison.
- **Un oubli de `lego` dans `CATALOG_BY_TYPE` ou dans le scatter-gather du gateway** donne une
  liste vide en silence, pas une erreur.
- PowerShell 5.1 : ni `&&` ni `||` (utiliser `; if ($?) { ... }`). Sources `.ps1` en ASCII pur.
