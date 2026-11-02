## acervatim-backend-lego

Service catalogue **LEGO** d'Acervatim (NestJS, Prisma, MariaDB). Premier service extrait de la
cible micro-services decrite dans `../../docs/agent/backend/architecture-microservices.md` :
il tourne seul aujourd'hui, et est ecrit pour se ranger derriere le `gateway` sans reecriture.

Perimetre : **recherche et identification de sets LEGO** (par nom, par code-barres, par type de
set) + l'index local qui les rend possibles. Le CRUD collections / noeuds / items **n'est pas
ici** : il vient de `libs/catalog-core` au jalon M6, il ne se forke pas (voir README).

## Policy

- Aucune donnee personnelle : ce service ne connait qu'un `userId` opaque venu d'`identity`. Ne
  jamais ajouter a `source_credentials` un champ qui reidentifie un humain.
- Aucune `@relation` Prisma ne franchit la frontiere du schema `acv_cat_lego`. C'est l'invariant
  central du decoupage ; un `userId` reste une colonne nue, sans FK.
- Ne nommer aucun materiel ni hebergeur (Raspberry Pi, NAS, AWS...) dans le code ou un
  commentaire. Les contraintes reelles sont : image `linux/arm64`, MariaDB via le provider
  Prisma `mysql`.
- **Aucun appel sortant depuis un controller ou un service metier.** Toute source passe par sa
  file BullMQ (debit borne, single-flight) puis par `ApiCacheService`.
- **Brickset ne doit jamais etre appele sur le chemin d'une requete utilisateur.** Son quota est
  de 100 appels/jour : un seul appel interactif consomme le budget de tous. Il n'alimente que le
  moissonnage nocturne.
- Toute la documentation de conception va dans `../../docs`. Ici : README + AGENTS.md.
- Pas de nouvelle dependance sans accord prealable.

## Where things are

- Cible d'architecture, contrat des routes `/internal/*`, phasage :
  `../../docs/agent/backend/architecture-microservices.md`.
- Regles de contrat API (Zod, RFC 9457, pagination cursor, filtres) :
  `../../docs/agent/backend/contrats-api-v1.md`. Elles s'appliquent telles quelles.
- Paysage des sources externes du monolithe (BYOT / repli premium / mode degrade) :
  `../../docs/agent/transverse/sources-externes.md`. La resolution de jeton d'ici en est
  la transposition.
- Pas de `lib/` ni de `utils/` global : tout va dans `src/common/<sous-dossier explicite>/`.

## Running and verifying

- `npm`, `npx`, `node`, `prisma`, `nest` ne se lancent **jamais** depuis Windows : passer par
  `./scripts/dev.ps1`, qui les execute dans le conteneur `app`. Un lancement hote produit des
  artefacts Prisma inutilisables dans le conteneur.
- Demarrage : `./scripts/dev.ps1 up-bg`. Verification de compilation : `./scripts/dev.ps1 build-ts`.
  Tests : `./scripts/dev.ps1 test`.
- **`docker compose restart` ne relit pas `.env`.** Apres toute modification du `.env`, utiliser
  `docker compose up -d --force-recreate app`, sinon le conteneur tourne avec l'ancienne
  configuration et les symptomes sont trompeurs (JWT « invalide », cle « absente »).
- Les ports sont decales (3010 / 3307 / 6380) pour cohabiter avec la stack du monolithe.

## Conventions that differ from defaults

- Validation par Zod via `nestjs-zod` (`createZodDto`) - pas de `class-validator`.
- Erreurs RFC 9457 sous les **memes URI `type`** que le monolithe (`https://api.acervatim/probs/...`).
  Le gateway relaie le corps tel quel : inventer un espace de noms local casserait l'app.
- Authentification par `PrincipalGuard`, pas par un `JwtAuthGuard`. Deux modes : principal signe
  `X-Acervatim-Principal` (derriere le gateway) ou JWT verifie localement (mode autonome). En
  mode autonome, `premium` vaut `false` : ce service ne peut pas resoudre le premium.
- Le `premium: true` de `SYSTEM_CTX` (moissonneur) n'accorde aucun droit a un humain : il force
  l'usage de la cle serveur, seule cle qui ait un sens pour un job sans proprietaire.
- Pas d'emoji dans le code ni dans les messages de commit.

## Known pitfalls

- PowerShell 5.1 : ni `&&` ni `||` (utiliser `; if ($?) { ... }`). Garder les sources `.ps1` en
  ASCII pur.
- `prisma migrate dev` a besoin de creer une shadow database : sans `db/init/01-grants.sql`
  applique a la creation du volume, il echoue en `P3014`. Apres un `reset`, le grant repasse seul.
- `SetIndexService.upsertFromRebrickable` ne doit **jamais** ecrire `ean`/`upc` : Rebrickable ne
  les connait pas, et un `update` naif effacerait le resultat du moissonnage Brickset.
