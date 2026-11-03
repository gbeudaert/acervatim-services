# Rebrickable data

Base de reference du catalogue LEGO : sets, themes, figurines et codes-barres.

- **Perimetre** : import quotidien des CSV publics Rebrickable, moissonnage Brickset des
  codes-barres, lectures `/internal/*` pour les services voisins.
- **Schema SQL** : `acv_rebrickable` · **Port** : 3190
- **Expose** : `/internal/*` (jeton interne), `/admin/*` (jeton admin), `/health*`. **Pas de
  route `/v1/*`, pas de routage gateway.**
- **Cible et decoupage** : `../../../acervatim-docs/agent/backend/architecture-microservices.md`

---

## 1. Pourquoi ce service

L'index LEGO de `catalog-lego` se construit en parcourant l'API Rebrickable page par page. Deux
problemes : la documentation de l'API renvoie aux CSV pour un catalogue complet, et les CGU
(5.3) n'autorisent l'automatisation que pour la page Downloads. Il manquait par ailleurs une base
qui soit **la** reference des sets, au lieu d'un index rempli au fil des recherches.

`rebrickable-data` est cette base. Il ne connait aucun utilisateur et ne repond qu'a ses voisins.
Le branchement de `catalog-lego` sur ses routes `/internal/*` est le lot suivant.

---

## 2. Deux alimentations, deux regimes

| | CSV Rebrickable | Brickset |
|---|---|---|
| Donnees | sets, themes, inventaires, figurines | `ean`, `upc`, `brickset_id` **uniquement** |
| Acces | `cdn.rebrickable.com/media/downloads/`, sans cle | `getSets`, cle `BRICKSET_API_KEY` |
| Contrainte | au plus une fois par jour (CGU) | 100 appels par jour UTC sur une cle libre |
| Declenchement | passage quotidien, `POST /admin/import/rebrickable` | meme passage, juste apres, `POST /admin/harvest/brickset` |
| Garde | `Last-Modified` de `sets.csv.gz` | budget du jour UTC dans `api_cache` |

**Un seul cron, 03:00 UTC** (fuseau fixe, pas celui de l'hote) : import des CSV **puis** campagne
Brickset, la seconde meme si l'import est `unchanged` ou `failed`. Au demarrage, un catalogue vide
declenche le meme enchainement en tache de fond (jamais sous `NODE_ENV=test`).

Les deux ecrivent `lego_sets`, mais **jamais les memes colonnes** : l'import ne cite ni `ean` ni
`upc` ni `brickset_id`, le moissonnage ne cite qu'eux. Aucune des deux sources ne peut defaire le
travail de l'autre.

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

### 2.2 La campagne Brickset

Pages de 500 (~45 appels pour le catalogue), une ecriture par set dont un code change :

- **mise a jour seule** : un set inconnu n'est pas cree, il est compte dans `unmatched`. Le
  rapprochement ignore la casse (`COMCON001` trouve `comcon001-1`) ;
- un code vide est ignore - il n'efface jamais un code connu. Un GTIN-14 a zero de tete est
  stocke sur ses 13 chiffres, la forme qu'un scan retrouve ;
- une meme reference deux fois dans une page (variante `0` ramenee a `1`) n'est ecrite et
  comptee qu'une fois ;
- budget du jour atteint - ou refus `API limit exceeded` de Brickset, qui sature le compteur du
  jour : run `paused`. La campagne suivante **relit la derniere page consommee** puis continue
  (un set insere entre-temps decalerait les pages ; un appel de recouvrement vaut mieux qu'un
  trou), avec le meme mode et la meme borne haute, et passe l'ancien run a `superseded` ;
- premiere campagne `full`, puis `incremental` avec `updatedSince` = filigrane du **dernier
  `done`, tout mode confondu**.

Le quota est compte au plus juste : une unite par appel, comptee **avant** l'envoi, jamais
consommee si Redis (la file) est indisponible, et **une seule tentative HTTP par appel** - une
nouvelle tentative du client serait un appel reel invisible du compteur. La cle API n'entre pas
dans Redis : le job ne porte que les parametres `getSets`, le worker ajoute la cle.

Deux corrections par rapport au moissonneur de `catalog-lego` : il lisait le filigrane sur le
dernier `full` (l'incremental redemandait donc tout depuis la premiere campagne), et ne
cloturait jamais les runs en pause ou en echec.

---

## 3. Routes

| Route | Garde | Reponse |
|---|---|---|
| `GET /internal/sets?q&theme&offset&limit` | interne | `InternalLegoSetPage` (`limit` 1-100, defaut 50 ; `offset` 0-100 000) |
| `GET /internal/sets/by-barcode/:code` | interne | `{ items: InternalLegoSet[] }`, 20 au plus ; `400` hors 6-20 chiffres |
| `GET /internal/sets/:setNum` | interne | `InternalLegoSet`, `404` si inconnu |
| `GET /internal/themes?parent` | interne | `{ items: InternalLegoTheme[] }`, `404` si `parent` inconnu |
| `GET /admin/status` | admin | comptes, sets avec code-barres, budget Brickset, 10 derniers runs |
| `POST /admin/import/rebrickable?force` | admin | rapport d'import (`?force`, `=true`, `=1`, casse indifferente) |
| `POST /admin/harvest/brickset` | admin | rapport de campagne |

- `q` : le numero **commence par** la valeur, ou le nom la **contient**, sans tenir compte de la
  casse. Tri `year desc, setNum asc` (index dedie). Un parametre inconnu est un `400`.
- `theme` : slug (`technic`, `star-wars`), resolu vers le theme **et toute sa descendance**.
  Slug inconnu ou theme retire : `404`. Un slug n'est **pas** un identifiant stable (un
  renommage Rebrickable peut le deplacer) : pour memoriser un theme, garder son `id`.
- `by-barcode` : EAN-13 ou UPC-A, avec ou sans tirets. Un UPC-A est un EAN-13 sans son zero de
  tete : les deux formes sont cherchees.
- `contributedBy` vaut `['rebrickable']`, plus `'brickset'` si `bricksetId` est renseigne. Il
  se deduit des donnees ; il n'y a plus de colonne `sources`.

Les formes sont dans `src/common/internal/contracts.ts`, section `rebrickable-data`.

---

## 4. Demarrage

```powershell
cd ..                                   # backend-services/
./scripts/dev.ps1 build rebrickable-data
./scripts/dev.ps1 up-one rebrickable-data   # base vide : import + campagne en tache de fond
./scripts/dev.ps1 lego-status
./scripts/dev.ps1 lego-import               # `unchanged` si les CSV n'ont pas bouge
./scripts/dev.ps1 lego-import force         # reimport complet, ~2 s
```

`lego-*` lit `ADMIN_API_TOKEN` dans `backend-services/.env`, quel que soit le repertoire courant,
et affiche le corps Problem Details en cas d'erreur HTTP.

Sans `BRICKSET_API_KEY`, `lego-brickset` rend `skipped` : le catalogue est complet, sans
codes-barres.

**Transition.** Tant que `catalog-lego` n'est pas branche sur ce service, `BRICKSET_API_KEY`
n'est renseignee **que** dans le `.env` de la constellation, et laissee vide dans
`catalog-lego/.env` : deux moissonneurs sur la meme cle se partageraient le quota du jour, et
chacun croirait disposer de tout.

Sur un volume MariaDB cree avant ce service, `db/init/01-schemas.sql` n'est pas rejoue : c'est
`prisma migrate deploy`, au demarrage du conteneur, qui cree `acv_rebrickable`.

---

## 5. Reste a faire

- **Brancher `catalog-lego`** (lot suivant) : ses recherches par code-barres, theme et nom, son
  detail de set et sa liste de themes lisent `/internal/*` ; son index local, son moissonneur et
  son client de l'API Rebrickable disparaissent.
- **Deploiement** : `deploy/` (Quadlet, manifeste, image de migration) ne connait pas encore ce
  service. A declarer avant toute mise en production.
- **Brickset n'a pas ete eprouve contre l'API reelle** dans ce service : aucune cle n'etait
  configuree. Le client, le worker et le budget sont ceux de `catalog-lego`, portes tels quels.
