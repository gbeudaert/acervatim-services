## acervatim-search

Recherche externe, pivot manga, files BullMQ et cache d'API (NestJS, Prisma, MariaDB). Schema
`acv_search`, port 3150. Cible :
`../../../acervatim-docs/agent/backend/architecture-microservices.md`.

## Policy

- **Aucun appel sortant depuis un controleur ou un service metier.** Toute source passe par sa
  file BullMQ (debit borne, single-flight) puis par `ApiCacheService`. C'est la regle qui tient
  les quotas ; la contourner « juste une fois » suffit a les faire sauter.
- **Aucun secret dans Redis.** Le payload d'un job porte le `userId` et l'URL publique ; la
  cle ou la signature est resolue et injectee **dans le worker**.
- **Ce service porte les cles serveur Acervatim, jamais celles des utilisateurs.** Les jetons
  personnels appartiennent a `connections` et ne sont lus que par
  `GET /internal/token/:userId/:provider`, qui rend une decision - il ne transmet aucune cle
  serveur, dans aucun sens.
- **Aucune cle de cache ne porte de `userId`.** C'est ce qui rend le mode degrade possible et
  ce qui fait qu'une suppression de compte n'a rien a supprimer ici. Ajouter un `userId` dans
  une cle casserait les deux d'un coup.
- **`GET /v1/search/edition-mapping` reste cache-only.** Aucun appel reseau dans le cycle
  requete-reponse : le fan-out de ~30 tomes depasse le timeout client (incident 0.5.3 / 0.6.2).
  Le remplissage se fait par le worker d'import.
- Ne nommer aucun materiel ni hebergeur dans le code ou un commentaire.
- Toute la documentation de conception va dans `../../../acervatim-docs`. Ici : README + AGENTS.md.
- Pas de nouvelle dependance sans accord prealable.

## Where things are

- `src/sources/adapters/` : les adapters, **moitie « recherche » seulement** - leur moitie
  « flux OAuth » est dans `connections`.
- `src/sources/token-client.service.ts` : la frontiere avec `connections`. Sa forme de retour
  est identique a celle du `TokenResolverService` du monolithe, a dessein : les `switch
  (resolution.source)` des adapters n'ont pas bouge.
- `src/sources/{bnf,googlebooks,mangadex}/` : les sources sans OAuth, inchangees.
- `src/search/import/` : import d'edition asynchrone (fire-and-poll).
- `src/search/watch/` : rattrapage hebdomadaire des tomes manga et `GET /v1/series-updates`. Les
  series viennent de `catalog-manga`, le premium de `billing`, par leurs routes `/internal/*`
  (`catalog-client.service.ts`, `premium-client.service.ts`) - jamais par une lecture de base.
- `src/sources/gameupc/`, `src/sources/bgg/`, `src/search/boardgame/` : code-barres de jeu de
  societe -> BGG. `src/common/barcode/gtin.ts` normalise **avant** tout appel : GameUPC ne valide
  rien et indexe la chaine recue. Le client BGG ne part pas sans `BGG_API_TOKEN`.
- `src/metrics/` : `/v1/admin/queues`. Toutes les files du systeme ayant suivi ce service,
  c'est ici et nulle part ailleurs que la passerelle sortante s'observe.
- `src/common/internal/contracts.ts` : contrat des routes `/internal/*`. **Identique dans tous
  les services** - le modifier d'un seul cote casse la constellation en silence.

## Running and verifying

- Tout passe par le wrapper de la racine : `../scripts/dev.ps1 up-bg`,
  `../scripts/dev.ps1 logs search`, `../scripts/dev.ps1 test search`.
- `npm`, `npx`, `node`, `prisma`, `nest` ne se lancent **jamais** depuis Windows : passer par
  `../scripts/dev.ps1 <cmd> search`.
- `GET /v1/admin/queues` (Bearer `ADMIN_API_TOKEN`) donne backlog, debit et echecs par file,
  plus le taux de hit du cache par famille de cles - c'est l'outil de calibrage des limiters.
- **`docker compose restart` ne relit pas `.env`.** Apres modification, utiliser
  `docker compose up -d --force-recreate search`.

## Conventions that differ from defaults

- Authentification par `PrincipalGuard`, pas par un `JwtAuthGuard`.
- **Pas d'exclusion `admin/(.*)` du prefixe `/v1`** : `/v1/admin/queues` fait partie du contrat
  public et le gateway l'y cherche. L'exclure la servirait sous `/admin/...`, ou personne ne
  regarde.
- `oauth1.ts` est **volontairement duplique** avec `connections`. Ne pas « factoriser » : cela
  creerait une dependance entre deux `apps/`, ce que l'invariant du 1 interdit.
- Validation par Zod via `nestjs-zod` (`createZodDto`) - pas de `class-validator`.
- Erreurs RFC 9457 sous les **memes URI `type`** que le monolithe.
- Pas d'emoji dans le code ni dans les messages de commit.

## Known pitfalls

- **Un `403 source-token-required` a maintenant deux causes possibles** : l'utilisateur n'a ni
  jeton ni premium (nominal), ou `connections` est injoignable (pas nominal). Seuls
  `/health/ready` et les journaux font la difference - ne pas conclure trop vite a un probleme
  de compte utilisateur.
- **Le garde-fou des editions d'art.** MangaDex indexe les jaquettes par numero de tome **sans
  dimension edition** : sur une Colossale, une Perfect ou une Kanzenban, le tome N rendrait le
  visuel du **standard**. `isSpecialArtEdition` fait sauter MangaDex pour ces editions ; le
  retirer donnerait des jaquettes fausses, pas une erreur.
- **La concurrence des resolutions de jaquette est bornee a 4, et ce n'est pas de la prudence
  excessive.** Le limiter de file serialise deja le debit sortant : un `Promise.all` large
  n'accelere rien et gonfle le backlog Redis. Historiquement, sous bucket SQL, il produisait un
  livelock qui resolvait ZERO jaquette.
- La resolution de jeton est desormais un **appel reseau par requete**. C'est le seul de ce
  service sur le chemin chaud ; le mesurer avant d'ajouter quoi que ce soit d'autre.
- **Titre de serie d'une pre-notice BnF** : sans 461, 225$a est la collection de l'editeur, pas
  la serie. Ne pas revenir a « 461$t, sinon 225$a, sinon 200$a » (cf. `scanSeriesTitle`).
- PowerShell 5.1 : ni `&&` ni `||` (utiliser `; if ($?) { ... }`). Sources `.ps1` en ASCII pur.
