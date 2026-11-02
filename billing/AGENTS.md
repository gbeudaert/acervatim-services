## acervatim-billing

Premium, abonnements Google Play et invitations (NestJS, Prisma, MariaDB). Schema
`acv_billing`, port 3120. Cible :
`../../../acervatim-docs/agent/backend/architecture-microservices.md`.

## Policy

- **Ce service est la source de verite du statut premium.** Aucun autre ne doit calculer ce
  droit : ils l'obtiennent par `GET /internal/premium/:userId`, ou par le principal signe que
  le gateway en derive.
- **Aucune donnee personnelle.** Ce service ne connait qu'un `userId` opaque venu d'`identity`.
  Un `purchaseToken` n'est pas une donnee de compte Google exploitable, mais il ne doit jamais
  etre journalise.
- **Aucune `@relation` Prisma ne franchit la frontiere du schema `acv_billing`.** `userId`
  reste une colonne nue, sans FK. La seule FK du schema (`invitation_redemptions` ->
  `invitations`) est intra-service : la regle interdit les relations qui franchissent une
  frontiere, pas les relations tout court.
- **Ne jamais ecraser un `PremiumGrant` existant.** Un utilisateur peut avoir un grant
  permanent qu'une invitation a duree limitee ne doit pas degrader.
- Ne nommer aucun materiel ni hebergeur dans le code ou un commentaire.
- Toute la documentation de conception va dans `../../../acervatim-docs`. Ici : README + AGENTS.md.
- Pas de nouvelle dependance sans accord prealable.

## Where things are

- `src/premium/premium.service.ts` : la regle de calcul du droit. Un seul endroit.
- `src/premium/premium-cache-invalidator.service.ts` : previent le gateway qu'un droit vient
  de changer. A appeler apres **toute** operation qui accorde un droit.
- `src/subscriptions/` : Google Play (verify + RTDN + cron de reconciliation).
- `src/invitations/` : codes anonymes, HMAC, consommation atomique.
- `src/common/internal/contracts.ts` : contrat des routes `/internal/*`. **Identique dans tous
  les services** - le modifier d'un seul cote casse la constellation en silence.

## Running and verifying

- Tout passe par le wrapper de la racine : `../scripts/dev.ps1 up-bg`,
  `../scripts/dev.ps1 logs billing`, `../scripts/dev.ps1 test billing`.
- `npm`, `npx`, `node`, `prisma`, `nest` ne se lancent **jamais** depuis Windows : passer par
  `../scripts/dev.ps1 <cmd> billing`. Un lancement hote produit des artefacts Prisma
  inutilisables dans le conteneur.
- Sans credentials Google Play, `POST /v1/subscriptions/verify` repond `503` : c'est le
  comportement attendu, pas une panne. `GET /health/ready` dit ce qui est configure.
- **`docker compose restart` ne relit pas `.env`.** Apres modification, utiliser
  `docker compose up -d --force-recreate billing`.

## Conventions that differ from defaults

- Authentification par `PrincipalGuard`, pas par un `JwtAuthGuard`.
- Le journal d'audit vit dans `identity` : passer par `AuditClientService`, jamais par une
  table locale. L'ecriture est best-effort - un echec d'audit alerte, il ne fait pas echouer
  une verification d'achat.
- Validation par Zod via `nestjs-zod` (`createZodDto`) - pas de `class-validator`.
- Erreurs RFC 9457 sous les **memes URI `type`** que le monolithe.
- Pas d'emoji dans le code ni dans les messages de commit.

## Known pitfalls

- **Le webhook RTDN est la seule route dont le gateway retransmet `Authorization`.** Son jeton
  est signe par Google, pas par nous. Si le webhook se met a repondre 401 sans raison
  apparente, verifier `forwardAuthorization: true` dans la table de routage du gateway avant
  de chercher ailleurs.
- **Aucun throttle sur le webhook**, ici comme au gateway : un `429` ferait retenter Pub/Sub
  en boucle et transformerait un pic legitime en tempete.
- Un RTDN peut arriver **avant** le `/verify` initial : le token est alors inconnu et on
  acquitte sans rien faire (`pending_verify`). Repondre en erreur ferait retenter Google
  indefiniment pour un cas nominal.
- La suppression de compte n'annule **rien** chez Google Play. C'etait deja vrai dans le
  monolithe ; ne pas laisser croire l'inverse dans un message d'API.
- PowerShell 5.1 : ni `&&` ni `||` (utiliser `; if ($?) { ... }`). Sources `.ps1` en ASCII pur.
