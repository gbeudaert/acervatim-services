# Billing

Premium, abonnements Google Play, invitations.

- **Perimetre** : statut premium (source de verite), verification d'achat Play, webhook RTDN,
  codes d'invitation.
- **Schema SQL** : `acv_billing` · **Port** : 3120
- **Cible et decoupage** : `../../../acervatim-docs/agent/backend/architecture-microservices.md`
- **Conventions API** : `../../../acervatim-docs/agent/backend/contrats-api-v1.md`

---

## 1. Ce service repond a une question, et il est le seul a savoir y repondre

`GET /internal/premium/:userId` -> `{ premium, source, expiresAt }`.

C'est **la route la plus appelee de la constellation** : le gateway l'interroge sur chaque
requete du domaine collection, et `sharing` pour connaitre le statut d'un proprietaire. Elle
doit rester une lecture de deux lignes.

La regle de calcul est inchangee depuis le monolithe : premium = grant actif **ou** abonnement
actif. Le grant est prioritaire, y compris quand un abonnement existe - un beta-testeur qui
souscrit quand meme ne doit pas perdre son grant. Les statuts Play consideres actifs sont
`active`, `grace_period` et `cancelled` tant que `expiresAt` n'est pas depasse : Play laisse
l'utilisateur premium jusqu'a la fin de la periode payee.

---

## 2. Le cache du gateway, et pourquoi ce service l'invalide

Le gateway met cette route en cache 60 s (3.6). Ce TTL est un compromis assume **dans un seul
sens** :

- une **perte** de premium peut mettre une minute a produire effet, ce qui est sans
  consequence : elle *suspend* les partages, elle ne detruit rien ;
- un **gain** ne peut pas attendre. Un utilisateur qui vient de payer, ou de consommer une
  invitation, ne doit pas se voir refuser ses propres collections en `402` pendant une minute.

D'ou l'appel a `DELETE /internal/premium-cache/:userId` sur le gateway apres toute operation
qui accorde un droit - verification d'achat, RTDN traite, invitation consommee. **Best-effort** :
si le gateway ne repond pas, l'achat reste enregistre et le TTL fait le travail avec du retard.
Faire echouer une verification d'achat parce qu'un cache n'a pas pu etre vide serait hors de
proportion, et laisserait Google Play croire que l'achat n'a pas ete pris en compte.

---

## 3. Le webhook RTDN et le seul en-tete `Authorization` que le gateway retransmet

`POST /webhooks/google-play/rtdn` est hors `/v1` et hors JWT : Google ne possede pas notre
jeton. Son authentification est un **JWT OIDC signe par Google**, joint en `Authorization` et
verifie par `PubsubVerifierService`.

Le gateway supprime `Authorization` de toutes les requetes qu'il transmet - l'identite passe
par le principal signe, et retransmettre le JWT d'un utilisateur permettrait a un service de le
rejouer ailleurs. Cette route est la **seule exception** de la table de routage, declaree
explicitement par `forwardAuthorization: true`, et un test verrouille le fait qu'elle reste
unique.

Aucun throttle non plus, des deux cotes : un `429` ferait retenter Pub/Sub en boucle.

---

## 4. Sans Google Play

`GOOGLE_PLAY_PACKAGE_NAME` et `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` sont **optionnels**. Sans eux,
la verification d'achat et le webhook repondent `503`, et tout le reste fonctionne : les grants
manuels et les invitations suffisent a rendre un compte premium en developpement. Les rendre
obligatoires empecherait de travailler sur la constellation entiere sans un compte Play.

`GET /health/ready` expose `googlePlay.configured` et `googlePlay.pubsub` pour eviter d'avoir
a le deviner.

---

## 5. Invitations

Inchange : un code anonyme de ~144 bits, dont seul HMAC-SHA-256(code, `INVITE_CODE_PEPPER`) est
stocke. Le code en clair n'est rendu qu'a la creation, a l'admin, et n'existe ensuite nulle
part - y compris pour nous.

La consommation est atomique et resistante a la concurrence : l'increment de `usedCount` est
garde par un `updateMany` conditionnel dans la meme transaction, donc deux consommations
simultanees sur la derniere place ne passent pas toutes les deux. Un grant existant n'est
**jamais** ecrase (`upsert` avec `update: {}`) : un utilisateur qui a deja un premium permanent
ne doit pas le voir degrade par une invitation a duree limitee.

Pepper **dedie**, distinct de `SHARE_CODE_PEPPER` : ces codes-ci sont crees par l'admin seul,
leur surface d'exposition et leur cadence de rotation different de celles des codes de partage,
que n'importe quel utilisateur genere.

---

## 6. Ce que la suppression de compte ne fait pas

`DELETE /internal/users/:id/data` efface l'abonnement, le grant et les consommations
d'invitation **de notre base**. L'abonnement continue d'exister chez Google, ou seul
l'utilisateur peut le resilier.

Ce n'est pas un oubli du decoupage : c'etait deja vrai dans le monolithe, ou la cascade Prisma
supprimait la meme ligne sans rien annuler chez Play. La suppression de compte n'a jamais
rembourse ni resilie quoi que ce soit.

---

## 7. Reste a faire

- **Purger les invitations expirees** : `InvitationsService.purgeExpired` existe et n'est
  appelee par aucun cron. Le monolithe avait le meme trou.
- **Mesurer la charge de `GET /internal/premium/:userId`** apres mise en service du cache du
  gateway : c'est le seul appel interne sur le chemin chaud, et le taux de hit reel decide si
  60 s est le bon TTL ou s'il est trop court.
- **`cancelReason`** est dans le schema et n'est jamais renseigne - heritage du monolithe.
  Soit on le remplit depuis `subscriptionsv2.get`, soit on le retire.
