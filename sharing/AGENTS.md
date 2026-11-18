## acervatim-sharing

Codes de partage, membres, portees par statut, et resolution d'acces (NestJS, Prisma,
MariaDB). Schema `acv_sharing`, port 3140. Cible :
`../../../acervatim-docs/agent/backend/architecture-microservices.md`, modele :
`../../../acervatim-docs/agent/backend/partage-de-collection.md`.

## Policy

- **Ne jamais relire les tables d'un catalog.** C'est la couture que le 3.1 supprime : ce
  service DEMANDE (`GET /internal/collections/:id/owner`, `POST /internal/items/count`), il ne
  lit plus. Une jointure vers `collections` ou `items` reintroduirait la dependance
  bidirectionnelle que le decoupage existe pour casser.
- **Aucun oracle d'existence.** Code inconnu, revoque, expire, epuise, membre ejecte : meme
  `404`, meme `detail`. Ajouter un cas distinct, meme « pour aider le client », rend le
  balayage de codes possible.
- **Un ensemble de statuts vide ne montre rien.** Sur une ligne abimee, l'ensemble vide est le
  bon sens de la defaillance ; l'inverse ouvrirait la collection entiere.
- **Les deux libelles ne se croisent jamais.** Celui du proprietaire et celui du membre sont
  prives l'un de l'autre. Ni log, ni metadonnee d'audit, ni reponse destinee a l'autre partie -
  seulement l'export RGPD de leur auteur.
- **Aucune `@relation` Prisma ne franchit la frontiere du schema `acv_sharing`.**
  `collection_id` reste une colonne nue.
- Ne nommer aucun materiel ni hebergeur dans le code ou un commentaire.
- Toute la documentation de conception va dans `../../../acervatim-docs`. Ici : README + AGENTS.md.
- Pas de nouvelle dependance sans accord prealable.

## Where things are

- `src/sharing/collection-access.service.ts` : `GET /internal/access`, la route dont depend
  tout le domaine collection. C'est le `CollectionAccessService` du monolithe, deplace de
  `premium/` vers ici comme l'architecture le prevoit.
- `src/sharing/catalog-client.service.ts` : le cote appelant de l'inversion du 3.1.
- `src/sharing/share-statuses.ts` : le vocabulaire des statuts, source depuis
  `common/internal/contracts.ts` et non depuis un import vers le domaine item.
- `src/common/internal/contracts.ts` : contrat des routes `/internal/*`. **Identique dans tous
  les services** - le modifier d'un seul cote casse la constellation en silence.

## Running and verifying

- Tout passe par le wrapper de la racine : `../scripts/dev.ps1 up-bg`,
  `../scripts/dev.ps1 logs sharing`, `../scripts/dev.ps1 test sharing`.
- Suite d'integration (`test/*.int-spec.ts`), contre la base `acv_sharing_it` recreee a chaque
  execution : `../scripts/dev.ps1 test-int sharing`. Une modification d'un partage, du redeem
  ou de la resolution d'acces se verifie par cette suite. Detail : README, 7.
- `npm`, `npx`, `node`, `prisma`, `nest` ne se lancent **jamais** depuis Windows : passer par
  `../scripts/dev.ps1 <cmd> sharing`.
- Un catalog eteint ne casse pas le service : les collections de ce type deviennent
  invisibles a la creation (404) et leurs entrees sortent avec `itemCount: null`.
- **`docker compose restart` ne relit pas `.env`.** Apres modification, utiliser
  `docker compose up -d --force-recreate sharing`.

## Conventions that differ from defaults

- Authentification par `PrincipalGuard`, pas par un `JwtAuthGuard`.
- **Ni `PremiumGuard` ni `@Throttle` locaux** : la gate premium de `POST /v1/shares` et le
  bucket a 5/min du redeem sont declares dans la table de routage du gateway. Les remettre ici
  ferait interroger `billing` deux fois par requete.
- Le journal d'audit vit dans `identity` : passer par `AuditClientService`.
- Validation par Zod via `nestjs-zod` (`createZodDto`) - pas de `class-validator`.
- Erreurs RFC 9457 sous les **memes URI `type`** que le monolithe.
- Pas d'emoji dans le code ni dans les messages de commit.

## Known pitfalls

- **`itemCount: null` n'est pas `itemCount: 0`.** `null` = « je n'ai pas pu compter », `0` =
  « il n'y a rien ». Les confondre ferait passer une panne de catalog pour un partage vide.
- **`collection_name` est une copie, pas la verite.** Elle peut vieillir. Le catalog rend le
  nom courant avec les comptes ; c'est lui qui gagne dans la reponse. Ne pas « optimiser » en
  supprimant ce realignement.
- **`expiresAt` ne filtre jamais une adhesion**, ni ici ni dans `GET /internal/access`. Il
  borne l'usage du code. L'ajouter au filtre ferait mentir `GET /v1/shares/received`, qui
  liste encore les partages expires.
- **Un membre ejecte ne revient pas avec le meme code.** Le controle `existing.revokedAt` du
  redeem est ce qui donne son sens a la revocation d'un membre tant que le partage vit.
- Les routes `received/...` et `redeem` sont declarees **avant** `:id` dans le controleur :
  Express resout dans l'ordre, et `:id` capterait sinon ces segments litteraux. Le gateway a
  la meme contrainte dans sa table, verrouillee par un test.
- PowerShell 5.1 : ni `&&` ni `||` (utiliser `; if ($?) { ... }`). Sources `.ps1` en ASCII pur.
