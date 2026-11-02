## acervatim-identity

Compte, authentification, journal d'audit et **orchestration de la suppression RGPD** (NestJS,
Prisma, MariaDB). Schema `acv_core`, port 3110. Cible :
`../../../acervatim-docs/agent/backend/architecture-microservices.md`.

## Policy

- **Aucune donnee perso directe.** Pas d'email, pas de nom. Le `sub` Google est hache
  HMAC-SHA-256 avec `SUB_HASH_PEPPER` et le resultat est l'unique pivot d'identite. Ne jamais
  ajouter a `users` un champ qui reidentifie un humain.
- **`JWT_PRIVATE_KEY` ne sort pas d'ici.** Ce service est la seule autorite d'emission de la
  constellation ; tout autre service qui signerait un jeton casserait ce point unique.
- **Le journal d'audit est append-only.** `AuditLogService` n'expose ni `update` ni `delete`,
  et `audit_logs.user_id` n'a **pas** de FK - volontairement : la ligne survit au compte.
- **Un participant ajoute a la saga se declare dans `SAGA_PARTICIPANTS`.** Un service qui
  stocke un `userId` sans figurer dans cette liste ne recevra jamais de demande de
  suppression, et la saga reussira, silencieuse et incomplete.
- Ne nommer aucun materiel ni hebergeur dans le code ou un commentaire.
- Toute la documentation de conception va dans `../../../acervatim-docs`. Ici : README + AGENTS.md.
- Pas de nouvelle dependance sans accord prealable.

## Where things are

- `src/saga/` : orchestration RGPD (3.4). `deletion-saga.service.ts` porte les decisions
  difficiles, commentees sur place.
- `src/auth/` : echange credential externe -> JWT. `identity-resolver.service.ts` est le seul
  fichier qui touche a la colonne d'identite.
- `src/users/` : `/v1/me`, export, suppression.
- `src/common/internal/contracts.ts` : contrat des routes `/internal/*`. **Identique dans tous
  les services** - le modifier d'un seul cote casse la constellation en silence.

## Running and verifying

- Tout passe par le wrapper de la racine : `../scripts/dev.ps1 up-bg`,
  `../scripts/dev.ps1 logs identity`, `../scripts/dev.ps1 test identity`.
- `npm`, `npx`, `node`, `prisma`, `nest` ne se lancent **jamais** depuis Windows : passer par
  `../scripts/dev.ps1 <cmd> identity`. Un lancement hote produit des artefacts Prisma
  inutilisables dans le conteneur.
- **`docker compose restart` ne relit pas `.env`.** Apres modification, utiliser
  `docker compose up -d --force-recreate identity`, sinon les symptomes sont trompeurs
  (JWT « invalide », participant « injoignable »).

## Conventions that differ from defaults

- Authentification par `PrincipalGuard`, pas par un `JwtAuthGuard`. Deux modes : principal
  signe `X-Acervatim-Principal` (derriere le gateway) ou JWT verifie localement (autonome).
- Validation par Zod via `nestjs-zod` (`createZodDto`) - pas de `class-validator`.
- Erreurs RFC 9457 sous les **memes URI `type`** que le monolithe. Le gateway relaie le corps
  tel quel : inventer un espace de noms local casserait l'app.
- Le throttler local (200/min) est un filet de securite contre un appel direct, pas la
  limitation principale - celle-ci est portee par le gateway.
- Pas d'emoji dans le code ni dans les messages de commit.

## Known pitfalls

- **Ne jamais marquer un job de saga `done` sans reponse du participant.** Un service retire
  de la configuration, un timeout, une 5xx : dans tous ces cas la donnee est peut-etre encore
  la. Le code refuse explicitement ce raccourci ; ne pas le « simplifier ».
- **Les jobs sont crees avant le fan-out, pas apres.** Inverser rendrait muette la fenetre
  pendant laquelle le processus peut mourir.
- Le journal d'audit **n'est pas supprime** par `DELETE /internal/users/:id/data`. C'est
  voulu : il ne re-identifie personne sans le pepper, et il est la preuve que la suppression
  a eu lieu.
- PowerShell 5.1 : ni `&&` ni `||` (utiliser `; if ($?) { ... }`). Sources `.ps1` en ASCII pur.
