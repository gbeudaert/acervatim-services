## acervatim-connections

Comptes externes de l'utilisateur : flux OAuth, cles personnelles, resolution de jeton (NestJS,
Prisma, MariaDB). Schema `acv_conn`, port 3130. Cible :
`../../../acervatim-docs/agent/backend/architecture-microservices.md`.

## Policy

- **Ce service detient les secrets des utilisateurs, pas les notres.** Les cles serveur
  Acervatim (`TMDB_API_KEY`, `DISCOGS_ACERVATIM_TOKEN`, le `MAL_CLIENT_ID` de consommation)
  appartiennent a `search`. `GET /internal/token/:userId/:provider` rend une **decision**,
  jamais une cle serveur. Ne pas « simplifier » en renvoyant la cle : ce serait faire
  transiter par le reseau interne un secret qui n'a aucune raison de bouger.
- **Aucun jeton en clair hors de ce service**, sauf par cette route interne, qui est protegee
  par le secret de service a service et jamais exposee par le gateway.
- **`ENCRYPTION_KEY` est obligatoire ici** (elle est optionnelle ailleurs) : c'est le seul
  service qui chiffre. Demarrer sans elle reviendrait a accepter des connexions qu'on ne
  saura pas stocker.
- **Aucune `@relation` Prisma ne franchit la frontiere du schema `acv_conn`.** `userId` reste
  une colonne nue, sans FK.
- **`api_cache` ne contient pas du cache ici, mais des secrets de flux** (token secret 1.0a,
  `code_verifier` PKCE) et l'identite de qui a lance chaque flux. Ne rien y ecrire d'autre, et
  ne pas allonger le TTL de dix minutes.
- Ne nommer aucun materiel ni hebergeur dans le code ou un commentaire.
- Toute la documentation de conception va dans `../../../acervatim-docs`. Ici : README + AGENTS.md.
- Pas de nouvelle dependance sans accord prealable.

## Where things are

- `src/oauth/providers/*.flow.ts` : les flux d'autorisation. **Uniquement la moitie « flux »**
  des adapters du monolithe ; leur moitie « recherche » est chez `search`.
- `src/oauth/token-resolver.service.ts` : la decision BYOT -> repli premium -> degrade.
- `src/sources/` : cles personnelles (BYOT), avec la liste blanche des providers acceptes.
- `src/common/internal/contracts.ts` : contrat des routes `/internal/*`. **Identique dans tous
  les services** - le modifier d'un seul cote casse la constellation en silence.

## Running and verifying

- Tout passe par le wrapper de la racine : `../scripts/dev.ps1 up-bg`,
  `../scripts/dev.ps1 logs connections`, `../scripts/dev.ps1 test connections`.
- `npm`, `npx`, `node`, `prisma`, `nest` ne se lancent **jamais** depuis Windows : passer par
  `../scripts/dev.ps1 <cmd> connections`.
- Sans credentials de fournisseur, le service demarre et les `/start` concernes repondent
  `503`. `GET /health/ready` expose `providers.discogs` et `providers.mal`.
- **`docker compose restart` ne relit pas `.env`.** Apres modification, utiliser
  `docker compose up -d --force-recreate connections`, sinon les symptomes sont trompeurs
  (« cle absente », flux qui echoue sans message clair).

## Conventions that differ from defaults

- Authentification par `PrincipalGuard`, sauf sur le **callback**, qui ne peut pas etre
  authentifie : le navigateur qui revient du fournisseur ne porte aucun JWT. C'est le flux en
  attente qui retablit l'identite.
- Pas de Redis ni de BullMQ dans ce service : les files ont suivi les adapters vers `search`.
- Validation par Zod via `nestjs-zod` (`createZodDto`) - pas de `class-validator`.
- Erreurs RFC 9457 sous les **memes URI `type`** que le monolithe.
- Pas d'emoji dans le code ni dans les messages de commit.

## Known pitfalls

- **Discogs range son token secret dans `refresh_token_encrypted`.** OAuth 1.0a n'a pas de
  refresh. Un « nettoyage » qui viderait ce champ pour les flux sans refresh casserait toutes
  les signatures Discogs, sans erreur explicite - Discogs repond un message generique.
- **MAL exige `code_challenge_method=plain`** : le challenge EST le verifier. Passer a S256
  parce que « c'est le standard » fait echouer l'echange avec une erreur illisible.
- Les URLs de callback pointent le **gateway**, pas ce service. Une URL qui pointerait
  directement ici fonctionnerait en developpement et casserait des que le gateway est le seul
  point d'entree expose.
- Un jeton MAL expire n'est **pas** rafraichi aujourd'hui : l'appel echoue cote `search`. Le
  `refresh_token` est pourtant stocke - voir « Reste a faire » du README.
- PowerShell 5.1 : ni `&&` ni `||` (utiliser `; if ($?) { ... }`). Sources `.ps1` en ASCII pur.
