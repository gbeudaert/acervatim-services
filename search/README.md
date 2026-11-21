# Search

Recherche externe, pivot manga, files BullMQ et cache d'API.

- **Perimetre** : `/v1/search*`, adapters Discogs / MAL / TMDB / BnF / Google Books / MangaDex,
  import d'edition asynchrone, rattrapage des tomes manga (`/v1/series-updates`),
  `/v1/admin/queues`.
- **Schema SQL** : `acv_search` · **Port** : 3150
- **Cible et decoupage** : `../../../acervatim-docs/agent/backend/architecture-microservices.md`
- **Sources externes** : `../../../acervatim-docs/agent/transverse/sources-externes.md`
- **Files et scan** : `../../../acervatim-docs/agent/backend/scan-asynchrone-bullmq.md`

---

## 1. L'extraction la plus simple, sauf sur un point

L'architecture le dit : ce service est **deja un sous-systeme autonome** dans le monolithe.
Files BullMQ, `api_cache`, adapters ; il ne lit aucune table du domaine collection. C'est
pourquoi son extraction sert de validation a faible risque du transport interne.

Le point qui ne l'etait pas : `oauth/providers/discogs.adapter.ts` et `mal.adapter.ts` faisaient
**deux choses** - le flux d'autorisation et la recherche. Une seule classe, deux
responsabilites qui n'avaient en commun que le nom du fournisseur.

| | Ici (`search`) | Chez `connections` |
|---|---|---|
| `search`, `searchByBarcode`, `fetchDetails`, mappers | oui | - |
| Files BullMQ, appels sortants | oui | - |
| **Cles serveur Acervatim** (`TMDB_API_KEY`, `DISCOGS_ACERVATIM_TOKEN`, `MAL_CLIENT_ID`) | oui | non |
| Flux `start` / `callback`, PKCE, signature du flux | - | oui |
| **Jetons des utilisateurs** | non | oui |

La frontiere est `GET /internal/token/:userId/:provider`, qui rend une **decision** - `user` /
`fallback` / `none` - et **jamais une cle serveur**. `MAL_CLIENT_ID` a la meme valeur des deux
cotes mais deux roles : identifiant du flux la-bas, cle du repli premium ici.

`oauth1.ts` existe en double, ici et dans `connections`. Ce n'est pas un oubli : `connections`
signe les echanges du flux, `search` signe les appels de catalogue, et l'invariant du 1
interdit une dependance directe entre deux `apps/`. Quatre-vingts lignes de RFC figee valent
mieux qu'un couplage qui rendrait le decoupage cosmetique.

---

## 2. Une route interne que le contrat du 6 ne prevoyait pas

`POST /internal/sources/snapshot`, servie ici, appelee par les catalogs.

`SourceSnapshotService` pre-remplissait la verite curee d'un item ou d'un noeud a
l'attachement d'une source (`POST /v1/items/:id/sources`). Il appartient au catalog, mais il
lui faut les adapters - qui ont suivi ce service. Sans cette route, il faudrait soit dupliquer
les adapters dans chaque catalog, soit renoncer au pre-remplissage. Les deux sont pires.

`rawData: null` signifie « provider sans adapter » (`bnf`, `mangadex`, `isbn`) : la reference
est conservee telle quelle. Le catalog s'en sert pour trancher une regle du contrat V1 - une
source sans adapter **et** sans `unifiedData` est un `400`, parce que rien ne decrirait la
ressource.

---

## 3. Ce service ne detient aucune donnee d'utilisateur

`DELETE /internal/users/:id/data` rend `0`, et c'est exact.

`api_cache` ne porte **aucun `userId` dans ses cles**, et c'est structurel : les reponses de
catalogue sont publiques, les partager entre utilisateurs ne fuit rien, et c'est precisement ce
qui rend possible le **mode degrade** - un utilisateur sans jeton lit ce qu'un autre a rempli -
ainsi que l'economie de quota qui permet au repli premium de tenir. Les jetons appartiennent a
`connections` ; les jobs d'import vivent dans Redis avec un identifiant derive du titre, pas du
demandeur.

Les votes GameUPC (section 7) sont la seule exception, et elle est transitoire : leur job porte le
**pseudonyme** du votant (HMAC sous `GAMEUPC_VOTER_PEPPER`), jamais son `userId`, et disparait de
Redis a l'envoi (sept jours s'il echoue definitivement). Rien n'est ecrit en base.

La route existe pour la symetrie du contrat : `identity` interroge tous les participants
declares, et un participant qui repondrait 404 ferait echouer une saga pour rien.

---

## 4. Ce qui n'a pas change, et qu'il ne faut pas defaire

- **Aucun appel sortant depuis un controleur.** Toute source passe par sa file BullMQ (debit
  borne, single-flight sur la cle de cache) puis par `ApiCacheService`. La signature ou la cle
  est injectee **dans le worker** : aucun secret ne transite par Redis, seuls le `userId` et
  l'URL publique voyagent dans le payload du job.
- **`GET /v1/search/edition-mapping` est cache-only.** Aucun appel reseau dans le cycle
  requete-reponse : c'est la correction du timeout client (incident 0.5.3 / 0.6.2, ou le
  fan-out de ~30 tomes depassait les 10 s d'OkHttp). Le remplissage reel se fait hors requete,
  par le worker d'import (`POST /v1/search/import-jobs`).
- **Circuit-breaker Redis.** Les producteurs consultent `RedisHealthService` **avant**
  d'enfiler : Redis indisponible -> `503` propre tout de suite, plutot que d'attendre les 15 s
  de `waitUntilFinished`.
- **La cascade de jaquettes** : MangaDex par serie (un appel pour toute l'edition) prioritaire,
  Google Books par ISBN en repli. Avec le garde-fou des editions d'art - MangaDex indexe par
  numero de tome **sans** dimension edition, donc sur une Colossale ou une Perfect il rendrait
  le visuel du standard.
- **Le titre de serie du scan ne prend pas 225$a par defaut.** Sur une pre-notice BnF (ni 461
  ni 410), 225$a est la collection de l'editeur (« Big Kana », « Shonen manga ») : la prendre
  pour la serie creait dans l'app une serie au nom de la collection, remplie de ses autres
  titres. 225$a n'est la serie que s'il porte le n° du tome (225$v sans 200$h) ; regle complete
  et cas reels dans `scanSeriesTitle` (`sources/bnf/edition-records.ts`).

---

## 5. Ce qui a change dans le comportement degrade

`connections` injoignable -> **toutes** les sources retombent en mode degrade (cache), puis
`403 source-token-required`. C'est le seul repli sur : supposer `fallback` consommerait la cle
serveur Acervatim pour un utilisateur peut-etre gratuit, et supposer `user` n'a aucun sens sans
jeton.

Consequence a connaitre : un `403 source-token-required` peut desormais avoir **deux causes** -
l'utilisateur n'a ni jeton ni premium (nominal), ou `connections` est en panne (pas nominal).
Le message reste actionnable dans les deux cas, mais `GET /health/ready` et les journaux sont
les seuls a faire la difference.

---

## 6. Recherche manga par titre et rattrapage des tomes

Reprise du chantier `feat/manga-recherche-serie` du monolithe (SD1 a SD3) :

- `GET /v1/search?type=manga` est servi par **MangaDex** (tri par suivis, doujinshi et
  anthologies exclus), sans jeton. MAL n'est plus qu'un repli, sur la premiere page seulement et
  sous jeton.
- `GET /v1/search/editions?mangaId=&title=` projette les notices BnF en editions, identifiees par
  l'**editeur normalise et la mention 205**. `edition-mapping` et l'import d'edition prennent
  `publisher` (et `since` pour `edition-mapping`).
- Un **passage hebdomadaire** (file `edition-watch`, lundi 4 h, planificateur BullMQ, concurrence
  globale 1) cherche les tomes parus depuis la derniere verification. `GET /v1/series-updates`
  (premium) les propose a l'app ; `POST /v1/admin/edition-watch/run` force un passage.

**C'est le premier code de ce service qui lit des donnees d'utilisateur, et il ne les lit pas en
base.** Les series et les volumes deja presents viennent de `catalog-manga`
(`GET /internal/nodes`, `GET /internal/users/:id/nodes`), le premium du proprietaire de
`billing` (`GET /internal/premium/:id`). Ce qui reste ici - l'etat par edition, cle
`edition-watch:v1:<hash>` dans `api_cache` - est indexe par **edition**, jamais par compte : le 3
tient toujours, une suppression de compte n'a rien a effacer ici.

Deux consequences de fonctionnement :

- `CATALOG_MANGA_BASE_URL` ou `BILLING_BASE_URL` absent : le passage ne surveille rien (journal
  `edition-watch: ... aucune edition surveillee`) et `GET /v1/series-updates` repond `503`.
- `catalog-manga` ou `billing` injoignable fait **echouer** le passage (job en echec, visible dans
  `/v1/admin/queues`) et `series-updates` repond `502`. Jamais une liste vide, qui dirait a
  l'app « rien de nouveau ».

---

## 7. Jeux de societe : code-barres -> BoardGameGeek

`GET /v1/search/boardgame/barcode/:code` et `POST .../:code/choice`. GameUPC donne l'identifiant
BGG d'un EAN/UPC ; le choix de l'utilisateur lui est renvoye (file `gameupc-feedback`, sous
pseudonyme HMAC) pour que le code soit verifie pour les suivants. BGG ne sert que la fiche
(`thing`), et **seulement si `BGG_API_TOKEN` est renseigne** - vide tant que la licence BGG
n'est pas accordee (non commerciale d'abord, commerciale avant le premium).

Le point a ne pas defaire : **`common/barcode/gtin.ts` normalise avant tout appel.** GameUPC ne
valide rien (`abc` rend un jeu au hasard, une cle de controle fausse cree un enregistrement) et
indexe la chaine (`019962194719` est verifie, `0019962194719` ne l'est pas). Conception, ecarts au
Swagger et questions ouvertes : `../../../acervatim-docs/agent/backend/gameupc-bgg.md`.

---

## 8. Demarrage

```powershell
cd ..                              # backend-services/
Copy-Item .env.example .env
./scripts/dev.ps1 up-bg
./scripts/dev.ps1 logs search
```

Sans cle serveur, une source ne repond qu'aux utilisateurs ayant connecte la leur.
`GET /health/ready` expose `sources.*` pour eviter de le deviner, et `GET /v1/admin/queues`
donne le backlog, le debit et les echecs de chaque file, plus le taux de hit du cache par
famille de cles.

---

## 9. Banc d'essai du scan manga

`scripts/scan-resolve.ts` resout un lot d'ISBN **comme l'app** : le scan, puis l'import de la
serie avec le titre, l'edition, l'editeur et le mangaId qu'il rend, puis la liste des tomes
relue en cache seul. Il tourne dans le conteneur, sans HTTP ni identite, et ecrit un rapport
JSON par ISBN (chemin d'identification, serie, tomes, jaquettes et leur source).

```powershell
./scripts/dev.ps1 scan-resolve                     # test/fixtures/scanned-isbns.txt
./scripts/dev.ps1 scan-resolve test/fixtures/scanned-isbns.txt --compare test/fixtures/<ref>.result.json
```

`--compare` confronte le passage a un rapport de reference : celui du `scan-resolve` du
monolithe (meme format, a copier dans `test/fixtures/`) ou un passage precedent de ce script.
Une ligne par ISBN, `idem`, `ECART` ou `NOUVEAU`, sur le chemin, le titre de serie, l'edition, le
nombre de tomes et de jaquettes.

A savoir avant de lire un ecart :

- **Le premium n'est pas simule.** Il se resout dans `connections` et `billing`, et le worker de
  la file `mal` (partagee avec le service qui tourne) relit le jeton de l'utilisateur. Le banc
  scanne donc en utilisateur gratuit : un ISBN que MangaDex n'identifie pas finit en `bnf_only`
  la ou le monolithe, qui creait des utilisateurs premium, passait par MAL.
- **Les rapports ne sont pas suivis par git** (`test/fixtures/*.result.json`) : ils contiennent
  des titres et des jaquettes de sources tierces.

---

## 10. Reste a faire

- **Mesurer le surcout de la resolution de jeton.** Elle etait en memoire, elle est devenue un
  appel reseau **par requete de recherche** - le seul de ce service sur le chemin chaud. Un
  cache court cote `search`, sur le modele du cache premium du gateway, est probablement
  justifie ; personne ne l'a mesure.
- **Recalibrer les limiters** sur les budgets reels des comptes Discogs et MAL. Les valeurs
  actuelles viennent du monolithe et n'ont jamais ete confrontees a un quota mesure.
- **Jeux de societe** : cle de production GameUPC accordee le 2026-11-18 ; debit borne a
  20 jobs/min au total (15 consultations + 5 votes), sous les ~30 req/min que le mainteneur
  indique. Reste la licence BGG. Liste complete dans `gameupc-bgg.md`, section 8.
- **Cle de cache et jeton** : les cles sont partagees entre utilisateurs, y compris entre un
  appel BYOT et un appel serveur. C'est voulu (donnees publiques) mais cela signifie qu'un
  utilisateur avec sa propre cle beneficie du cache rempli par le repli premium, et
  reciproquement. A verifier avant tout changement de politique de quota.
