# Rebrickable data

Base de reference du catalogue LEGO : sets, themes, figurines et codes-barres.

- **Perimetre** : import quotidien des CSV publics Rebrickable, codes-barres Brickset demandes
  au scan, lectures `/internal/*` pour les services voisins.
- **Schema SQL** : `acv_rebrickable` · **Port** : 3190
- **Expose** : `/internal/*` (jeton interne), `/admin/*` (jeton admin), `/health*`. **Pas de
  route `/v1/*`, pas de routage gateway.**
- **Cible et decoupage** : `../../../acervatim-docs/agent/backend/architecture-microservices.md`

---

## 1. Pourquoi ce service

L'ancien `catalog-lego` construisait son index LEGO en parcourant l'API Rebrickable page par
page. Deux problemes : la documentation de l'API renvoie aux CSV pour un catalogue complet, et les CGU
(5.3) n'autorisent l'automatisation que pour la page Downloads. Il manquait par ailleurs une base
qui soit **la** reference des sets, au lieu d'un index rempli au fil des recherches.

`rebrickable-data` est cette base. Il ne connait aucun utilisateur et ne repond qu'a ses voisins.
Son consommateur est `search`, par l'adapter `rebrickable` (2026-11-17) : la recherche LEGO de
l'app passe par `GET /v1/search?type=lego`, sans appel externe depuis `search`. Les collections
des utilisateurs sont dans `catalog-lego`, refait sur `catalog-core`, qui n'appelle ni
Rebrickable ni Brickset.

---

## 2. Deux alimentations, deux regimes

| | CSV Rebrickable | Brickset |
|---|---|---|
| Donnees | sets, themes, inventaires, figurines | `ean`, `upc`, `brickset_id`, `barcode_checked_at` **uniquement** |
| Acces | `cdn.rebrickable.com/media/downloads/`, sans cle | `getSets`, cle `BRICKSET_API_KEY` |
| Contrainte | au plus une fois par jour (CGU) | 100 appels par jour UTC sur une cle libre |
| Declenchement | passage quotidien, `POST /admin/import/rebrickable` | scan d'un code absent du cache (`GET /internal/sets/by-barcode/:code`) |
| Garde | `Last-Modified` de `sets.csv.gz` | codes gardes 90 jours, codes inconnus 7 jours, budget du jour UTC |

**Un seul cron, 03:00 UTC** (fuseau fixe, pas celui de l'hote) : import des CSV, purge du cache,
**puis** effacement des codes-barres confirmes il y a plus de 90 jours, chaque etape meme si la
precedente a echoue. **Aucun appel a Brickset dans ce passage** : il n'y a plus de moissonnage
(retire le 2026-11-17). Au demarrage, un catalogue vide declenche le meme enchainement en tache
de fond (jamais sous `NODE_ENV=test`).

Les deux ecrivent `lego_sets`, mais **jamais les memes colonnes** : l'import ne cite ni `ean` ni
`upc` ni `brickset_id` ni `barcode_checked_at`, la recherche au scan ne cite qu'eux. Aucune des
deux sources ne peut defaire le travail de l'autre.

### 2.1 L'import CSV

1. `HEAD sets.csv.gz`. Meme `Last-Modified` que le dernier import `done` : rien n'est
   telecharge, run `unchanged`. `?force` passe outre. Un HEAD refuse (403, 405...) n'arrete
   rien : l'import se fait alors sans controle conditionnel.
2. `themes.csv.gz` : arbre complet recalcule a chaque import (`path` avec `' / '`, 10 ancetres au
   plus, `depth`, `slug` - le premier id d'un nom garde le slug nu, les suivants prennent
   `-{id}`, le tout tenu dans 255 caracteres). Un theme absent du CSV n'est pas supprime : il est
   marque **retire** (`retired_at`), n'est plus liste ni resolvable par slug, mais reste affiche
   comme theme des sets qui le referencent. Il redevient actif s'il reparait.
3. `inventories.csv.gz` puis `inventory_minifigs.csv.gz` : pour chaque set, l'inventaire de **plus
   petite version**, et la somme de ses quantites de figurines. `0` si cet inventaire n'a pas de
   figurine, `null` si le set n'a pas d'inventaire.
4. `sets.csv.gz` par lots de 1 000 en `INSERT ... ON DUPLICATE KEY UPDATE`. `updated_at`
   n'avance que si une valeur change.

Tout se lit en flux (gunzip puis `csv-parse` en mode colonnes). Un echec (HTTP, gzip, CSV, colonnes
manquantes) clot le run en `failed` avec `lastError` ; les lots deja ecrits restent. Un fichier
`themes`, `inventories` ou `sets` valide mais **vide** est aussi un echec : sinon toutes les
figurines passeraient a `NULL` sous un run `done`. Un set absent du CSV n'est **jamais** supprime.

`minifigs` ne compte que l'inventaire **propre** du set : les sets imbriques
(`inventory_sets` - packs, coffrets) ne sont pas suivis, un coffret vaut donc souvent `0`.

### 2.2 Brickset au scan

Decision du 2026-11-16 : Brickset n'est appele qu'au scan d'un code absent du cache. C'est ce
que decrit le courrier de demande d'accord a Brickset (`pending`).

1. Un set des CSV porte ce code, confirme depuis moins de `BRICKSET_BARCODE_TTL_DAYS` (90) :
   il est servi, sans appel. `lookup: 'cache'`.
2. Le code est marque inconnu depuis moins de `BRICKSET_MISS_TTL_DAYS` (7) : liste vide, sans
   appel. `lookup: 'miss'`. Les 7 jours sont un choix valide le 2026-11-17 : un set neuf obtient
   vite son code chez Brickset, 90 jours bloqueraient son scan trois mois, et un delai plus court
   userait le budget du jour en scans repetes d'un code inconnu.
3. Pas de cle : `disabled`. Sinon **un** appel `getSets {query: code}`, par la file `brickset`
   (`concurrency: 1`, un appel toutes les 2 s, une tentative), compte avant l'envoi dans le
   budget du jour (`BRICKSET_DAILY_CALL_BUDGET`, 90 sur les 100 du quota). Budget atteint, ou
   refus `API limit exceeded` qui sature le compteur du jour : `exhausted`. Brickset ou la file
   en erreur : `unavailable`.
4. Seules les fiches qui **portent le code** (EAN ou UPC, avec l'equivalence UPC-A / EAN-13 a
   zero de tete) comptent : `query` cherche aussi dans les numeros et les noms. Pour chacune dont
   le set existe dans les CSV, `ean`, `upc` et `brickset_id` sont ecrits (jamais effaces par une
   valeur vide) et `barcode_checked_at` passe a maintenant, meme si les codes n'ont pas change.
   Aucun set n'est cree. `lookup: 'brickset'`. Rien d'annote : le code est marque inconnu,
   `lookup: 'miss'`.

Le code est cherche sous sa forme la plus courte : un EAN-13 a zero de tete est un UPC-A, et
Brickset le publie sur 12 chiffres. Deux scans simultanes du meme code partagent le meme appel
(single-flight en memoire, par code). Le scan n'attend Brickset que `BRICKSET_SCAN_WAIT_MS`
(6 s) : au-dela il rend `pending`, et l'appel, qui continue, sert le scan suivant. Une erreur ne
marque jamais un code inconnu.

**Les 90 jours sont un engagement.** Un code confirme il y a plus de 90 jours n'est plus servi,
et le passage quotidien efface ses quatre colonnes. La migration du 2026-11-17 a efface les codes
sans date, ecrits par l'ancien moissonnage.

**Hypothese a verifier au premier appel reel** : la documentation de l'API ne dit pas que
`query` cherche dans les codes-barres (seulement numero, nom, theme et sous-theme). La recherche
du site, elle, le fait : le 2026-11-17, `brickset.com/sets?query=5702015869935` (EAN) et
`?query=673419267656` (UPC) rendent tous deux `75192-1`. Si l'API ne le fait pas, chaque scan
rendra `miss` ; la question est posee dans le courrier a Brickset.

Le quota est compte au plus juste : une unite par appel, comptee **avant** l'envoi, jamais
consommee si Redis (la file) est indisponible, et **une seule tentative HTTP par appel** - une
nouvelle tentative du client serait un appel reel invisible du compteur. Les reservations du
budget passent une a une : plusieurs scans concurrents ne peuvent pas sous-compter. La cle API
n'entre pas dans Redis : le job ne porte que les parametres `getSets`, le worker ajoute la cle.

---

## 3. Routes

| Route | Garde | Reponse |
|---|---|---|
| `GET /internal/sets?q&theme&offset&limit` | interne | `InternalLegoSetPage` (`limit` 1-100, defaut 50 ; `offset` 0-100 000) |
| `GET /internal/sets/by-barcode/:code` | interne | `InternalLegoBarcodeLookup` (`items`, 20 au plus, et `lookup`) ; `400` hors 6-20 chiffres ; peut attendre Brickset 6 s |
| `GET /internal/sets/:setNum` | interne | `InternalLegoSet`, `404` si inconnu |
| `GET /internal/themes?parent` | interne | `{ items: InternalLegoTheme[] }`, `404` si `parent` inconnu |
| `GET /admin/status` | admin | comptes, sets avec code-barres en cache, budget Brickset du jour, 10 derniers runs |
| `POST /admin/import/rebrickable?force` | admin | rapport d'import (`?force`, `=true`, `=1`, casse indifferente) |

- `q` : le numero **commence par** la valeur, ou le nom la **contient**, sans tenir compte de la
  casse. Tri `year desc, setNum asc` (index dedie). Un parametre inconnu est un `400`.
- `theme` : slug (`technic`, `star-wars`), resolu vers le theme **et toute sa descendance**.
  Slug inconnu ou theme retire : `404`. Un slug n'est **pas** un identifiant stable (un
  renommage Rebrickable peut le deplacer) : pour memoriser un theme, garder son `id`.
- `by-barcode` : EAN-13 ou UPC-A, avec ou sans tirets. Un UPC-A est un EAN-13 sans son zero de
  tete : les deux formes sont cherchees. Seule route qui peut appeler Brickset (2.2).
- `contributedBy` vaut `['rebrickable']`, plus `'brickset'` si `bricksetId` est renseigne. Il
  se deduit des donnees ; il n'y a plus de colonne `sources`.

Les formes sont dans `src/common/internal/contracts.ts`, section `rebrickable-data`.

---

## 4. Demarrage

```powershell
cd ..                                   # backend-services/
./scripts/dev.ps1 build rebrickable-data
./scripts/dev.ps1 up-one rebrickable-data   # base vide : import en tache de fond
./scripts/dev.ps1 lego-status
./scripts/dev.ps1 lego-import               # `unchanged` si les CSV n'ont pas bouge
./scripts/dev.ps1 lego-import force         # reimport complet, ~2 s
./scripts/dev.ps1 lego-scan 5702015869935   # scan, comme l'app : cache, puis Brickset une fois
```

`lego-*` lit `ADMIN_API_TOKEN` (`lego-scan` : `INTERNAL_SERVICE_TOKEN`) dans
`backend-services/.env`, quel que soit le repertoire courant, et affiche le corps Problem
Details en cas d'erreur HTTP.

Sans `BRICKSET_API_KEY`, `lego-scan` rend `lookup: 'disabled'` : le catalogue est complet, sans
codes-barres.

`BRICKSET_API_KEY` n'est lue que par ce service : aucun autre de la constellation n'appelle
Brickset.

Sur un volume MariaDB cree avant ce service, `db/init/01-schemas.sql` n'est pas rejoue : c'est
`prisma migrate deploy`, au demarrage du conteneur, qui cree `acv_rebrickable`.

---

## 5. Reste a faire

- **Deploiement** : declare dans `deploy/` (conteneur du pod, migre par `acervatim-migrate`,
  secret `DATABASE_URL_REBRICKABLE_DATA`, lu par `search` via `REBRICKABLE_DATA_BASE_URL`), sans
  `BRICKSET_API_KEY` tant que l'accord de Brickset est `pending` - voir `../deploy/README.md` (8).
- **Brickset n'a jamais ete eprouve contre l'API reelle** : aucune cle n'est configuree. Le
  premier appel verifiera aussi que `query` trouve un set par son code-barres (2.2).
