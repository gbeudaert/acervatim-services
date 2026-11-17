# Connections

Comptes externes de l'utilisateur : flux OAuth, cles personnelles, et **resolution de jeton**.

- **Perimetre** : OAuth Discogs (1.0a) et MyAnimeList (2.0 PKCE), cles personnelles (BYOT),
  `GET /internal/token/:userId/:provider`.
- **Schema SQL** : `acv_conn` · **Port** : 3130
- **Cible et decoupage** : `../../../acervatim-docs/agent/backend/architecture-microservices.md`
- **Sources externes** : `../../../acervatim-docs/agent/transverse/sources-externes.md`

---

## 1. La coupure la plus fine du decoupage

Dans le monolithe, `DiscogsAdapter` et `MalAdapter` faisaient **deux choses** : le flux
d'autorisation (`start` / `callback`) et la recherche (`search`, `searchByBarcode`,
`fetchDetails`, la file BullMQ, les mappers). Une seule classe, deux responsabilites qui
n'avaient en commun que le nom du fournisseur.

Le decoupage les separe :

| | Ici (`connections`) | Chez `search` |
|---|---|---|
| Flux OAuth `start` / `callback` | oui | - |
| Stockage des jetons **utilisateur** | oui | - |
| Cles serveur Acervatim (`TMDB_API_KEY`, `DISCOGS_ACERVATIM_TOKEN`, `MAL_CLIENT_ID` de consommation) | **non** | oui |
| Files BullMQ, appels sortants, mappers | - | oui |
| Decision « quel jeton employer » | oui | - |

La frontiere est `GET /internal/token/:userId/:provider`, qui rend une **decision** :

```
user     -> voici les jetons de l'utilisateur (BYOT)
fallback -> l'utilisateur est premium : emploie TA cle serveur
none     -> mode degrade, puis 403 source-token-required
```

**`fallback` ne transmet aucune cle.** C'etait deja la regle dans le monolithe - « ce service
ne renvoie que la decision » - et le decoupage la rend structurelle : `search` detient les cles
Acervatim, `connections` celles des utilisateurs, et aucun des deux n'a a connaitre les secrets
de l'autre.

---

## 2. Le callback ne peut pas etre authentifie

`GET /v1/oauth/:provider/callback` est la seule route utilisateur de la constellation sans
identite : le navigateur qui revient de Discogs ou de MAL ne porte aucun JWT. C'est le **flux
en attente**, ecrit au `start` avec un TTL de dix minutes, qui retablit qui a commence quoi :

- Discogs (1.0a) : `{ userId, requestTokenSecret }`, indexe par le request token ;
- MAL (2.0 PKCE) : `{ userId, codeVerifier }`, indexe par le `state`.

Consequence : ces lignes sont des **secrets**, pas du cache. Elles sont supprimees des que le
flux aboutit, et un cron horaire purge celles qui ont expire - le monolithe notait cette purge
« sprint ulterieur » et ne l'a jamais ecrite, ce qui etait tolerable pour des reponses de
catalogue et ne l'est plus ici.

---

## 3. Deux particularites de fournisseur, deja presentes dans le monolithe

**Discogs stocke son token secret dans la colonne `refresh_token_encrypted`.** OAuth 1.0a n'a
pas de refresh mais a un secret appaire au jeton d'acces. Le detournement vient du monolithe ;
il est documente dans le schema Prisma parce que lire « refresh » sur un flux qui n'en a pas
est autrement incomprehensible.

**MAL utilise `code_challenge_method=plain`**, c'est-a-dire que le challenge *est* le verifier.
C'est non standard, mais c'est la documentation officielle de MAL - utiliser S256 fait echouer
l'echange avec une erreur generique.

---

## 4. Cles personnelles (BYOT)

`PUT|DELETE /v1/sources/:provider/token`, generalisation du `/v1/sources/tmdb/token` du
monolithe : une route par source aurait fait diverger deux implementations du meme geste.
L'ancien `catalog-lego` servait la meme forme pour Rebrickable ; refait le 2026-11-17, il n'a
plus aucune cle personnelle.

La liste blanche des providers acceptes n'est pas cosmetique. Sans elle, la route accepterait
n'importe quel nom et remplirait `oauth_credentials` de lignes qu'aucun adapter ne lira - au
mieux du bruit, au pire une ligne `discogs` posee a la main qui court-circuiterait le flux
OAuth et casserait la signature 1.0a, qui a besoin d'un token secret qu'une saisie manuelle ne
fournit pas. Une source a flux OAuth est donc refusee avec un message qui renvoie vers
`/v1/oauth/:provider/start`.

Aucune validation de la cle aupres du fournisseur : une cle invalide echouera au premier appel
reel. Decision heritee du monolithe - verifier a la saisie couterait un appel sortant par
enregistrement pour un gain que le premier usage donne gratuitement.

---

## 5. Ce que la suppression de compte ne fait pas

`DELETE /internal/users/:id/data` supprime les credentials **locaux**. Les autorisations
restent actives chez le fournisseur : ni Discogs ni MAL ne proposent de revocation par
l'application, et un appel de revocation qui echoue ne doit pas empecher la suppression du
compte. L'utilisateur peut retirer l'autorisation depuis son compte Discogs ou MAL.

L'export RGPD sort les jetons **chiffres**, comme le monolithe : un export doit contenir ce que
nous detenons, pas ce que nous pouvons en faire. Les livrer en clair mettrait dans un fichier
telechargeable de quoi usurper les comptes externes de l'utilisateur.

---

## 6. Demarrage

```powershell
cd ..                              # backend-services/
Copy-Item .env.example .env        # puis remplir ENCRYPTION_KEY et, si besoin, DISCOGS_*/MAL_*
./scripts/dev.ps1 up-bg
```

Sans `DISCOGS_CONSUMER_KEY` ni `MAL_CLIENT_ID`, le service demarre : les routes `/start`
concernees repondent `503`. `GET /health/ready` expose `providers.discogs` et `providers.mal`
pour eviter de le deviner.

Les URLs de callback pointent le **gateway** (`http://localhost:3100/v1/oauth/.../callback`),
pas ce service : c'est l'URL que le fournisseur affichera et vers laquelle le navigateur
reviendra.

---

## 7. Reste a faire

- **Rafraichir les jetons MAL expires.** `expiresAt` est stocke, `refresh_token` aussi, et
  rien ne s'en sert : un jeton MAL expire fait echouer l'appel cote `search` au lieu d'etre
  renouvele. Le monolithe avait deja ce trou ; il devient plus visible maintenant que la
  resolution est une route.
- **Rotation d'`ENCRYPTION_KEY`.** La colonne `encrypted_with_key_version` existe pour ca et
  vaut 1 partout. Sans procedure de rechiffrement, changer la cle rend tous les jetons
  illisibles d'un coup.
- **Revocation cote fournisseur** a la deconnexion, pour les fournisseurs qui l'exposent -
  aucun des deux actuels ne le fait.
