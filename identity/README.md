# Identity

Compte, authentification, journal d'audit, et **orchestration de la suppression RGPD**.

- **Perimetre** : auth Google -> JWT interne, `/v1/me`, export et suppression RGPD, journal
  d'audit, referentiel des types de collection.
- **Schema SQL** : `acv_core` · **Port** : 3110
- **Cible et decoupage** : `../../../acervatim-docs/agent/backend/architecture-microservices.md`
- **Conventions API** : `../../../acervatim-docs/agent/backend/contrats-api-v1.md`

---

## 1. Ce que ce service detient - et ce qu'il ne detient plus

**Il detient** : `users` (un UUID opaque et le hash HMAC du `sub` Google, rien d'autre),
`audit_logs`, `collection_types`, et `user_deletion_jobs`.

**Il ne detient plus** : collections, items, noeuds, credentials, abonnements, grants,
partages. Toutes ces tables sont parties dans d'autres schemas au moment du decoupage - et
avec elles, la cascade `onDelete: Cascade` qui rendait `DELETE /v1/me` trivial.

C'est la seule difference qui compte, et elle occupe le reste de ce document.

---

## 2. La saga de suppression (3.4) - le point a risque juridique du chantier

### Le probleme

Dans le monolithe, supprimer un compte etait une ligne : Prisma cascadait vers neuf tables.
**La cascade ne franchit pas une frontiere de schema.** `DELETE /v1/me` devient donc un
fan-out vers N services, chacun exposant un `DELETE /internal/users/:id/data` **idempotent**.

Une saga partiellement echouee laisse des donnees d'un compte supprime. Ce n'est pas un bug
de confort.

### Ce qui a ete decide, et pourquoi

**Le compte est supprime meme si un participant echoue.** Le choix inverse - refuser tant que
tout n'est pas efface - conserverait un compte utilisable dont l'utilisateur a demande la
suppression, et lui renverrait une erreur qu'il ne peut pas resoudre. Le RGPD demande
l'effacement, pas l'atomicite. On supprime, on trace ce qui reste, on rejoue.

**Les jobs sont crees avant le premier appel**, pas apres. Si le processus meurt au milieu du
fan-out, la reconciliation sait quoi rejouer ; les creer apres coup rendrait cette fenetre
muette.

**Les lignes de job survivent au compte** (aucune FK vers `users`). Sans cela, supprimer le
compte effacerait la trace de ce qu'il reste a supprimer ailleurs.

**Un job de reconciliation, pas seulement un retry en ligne.** Un retry en ligne ne survit pas
a la mort du processus. Le rejeu tourne toutes les 15 minutes, et `failed` n'est pas terminal -
c'est tout l'interet d'une route participante idempotente.

**Une alerte au-dela d'un seuil d'anciennete** (`SAGA_ALERT_AFTER_HOURS`, 24 h par defaut). Le
rejeu seul produirait un echec silencieux toutes les quinze minutes pendant qu'une donnee
reste en place.

### Constater

```
GET /internal/saga/deletions        [admin]  pending / failed / stale / le plus ancien
GET /internal/saga/deletions/retry  [admin]  rejeu immediat
GET /health/ready                            expose aussi le compteur, sans jeton
```

Le compteur est dans `/health/ready` a dessein : une saga qui traine est une non-conformite en
cours, et cette information ne doit pas dependre de la curiosite de celui qui regarde.

### Le piege de configuration

`SAGA_PARTICIPANTS` liste les services a solliciter (`nom=url,nom=url`). **Un service absent
de cette liste ne recoit jamais de demande de suppression.** C'est la ligne a completer en
meme temps qu'on ajoute un service qui stocke un `userId` - sinon la saga reussit, silencieuse
et incomplete. Une liste vide declenche un avertissement au demarrage.

---

## 3. L'export RGPD

`GET /v1/me/export` agrege desormais N reponses au lieu de N tables. **La forme du payload ne
change pas** : un export est fait pour etre relu par un outil tiers, et changer sa structure
casserait ce relecteur pour une raison qui ne le regarde pas. Les fragments sont aplatis dans
`data`, exactement comme les cles du monolithe.

Un seul ajout : `incomplete: string[]`. Un participant injoignable ne fait pas echouer
l'export - priver l'utilisateur d'un droit pour une panne qui ne le concerne pas serait
absurde - mais lui livrer un export ampute **sans le dire** serait pire.

---

## 4. Authentification

Inchange sur le fond : `POST /v1/auth/google` echange un `id_token` contre un JWT interne
RS256 de 7 jours. Le `sub` Google est hache HMAC-SHA-256 avec `SUB_HASH_PEPPER`, prefixe du
nom du provider pour eviter toute collision theorique entre deux fournisseurs.

**Ce service est la seule autorite d'emission de jetons de la constellation** : il est le seul
a detenir `JWT_PRIVATE_KEY`. Les autres n'ont que la cle publique, et depuis le 3.6 le gateway
est meme le seul a s'en servir - les services aval verifient un principal signe, pas un JWT.

Ajouter un provider (Apple, Facebook) reste ce qu'il etait : un DTO Zod, une methode de trois
lignes dans le controleur, et un `IdentityProvider`. Le passage a une table `user_identities`
n'a toujours pas ete fait ; tant qu'il ne l'est pas, `IdentityResolverService` refuse
explicitement tout provider autre que `google` plutot que d'ecrire dans la mauvaise colonne.

---

## 5. Demarrage

```powershell
cd ..                              # backend-services/
Copy-Item .env.example .env        # puis remplir JWT_*, GOOGLE_CLIENT_ID, SUB_HASH_PEPPER
./scripts/dev.ps1 up-bg
./scripts/dev.ps1 logs identity
```

---

## 6. Reste a faire

- **Tester la saga en conditions reelles**, participant eteint compris : tant que le rejeu et
  l'alerte n'ont pas ete observes sur une panne vraie, le 3.4 n'est pas termine - c'est la
  condition posee par l'architecture elle-meme, pas une precaution.
- **Table `user_identities`** pour le multi-provider, en remplacement de
  `users.google_sub_hash`. Aucun autre fichier ne touche a la colonne d'identite :
  l'abstraction tient dans `IdentityResolverService`.
- **Purger les jobs termines** au-dela d'une retention : `user_deletion_jobs` ne fait que
  croitre aujourd'hui. Les lignes `done` ne servent plus qu'a la preuve, une retention bornee
  suffirait.
