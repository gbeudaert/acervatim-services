# Changelog

Evolutions notables de la constellation Acervatim. Format inspire de
[Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) ; versionnage
[SemVer](https://semver.org/lang/fr/). Le numero est porte par les `package.json` des douze
paquets et par les tags d'image epingles dans `deploy/acervatim.yaml` : les deux changent
ensemble (`deploy/build-images.ps1 -Tag <version>`).

## [0.1.0] - 2026-11-21

Premiere version de la constellation : le contrat `/v1/*` du monolithe `acervatim-backend`,
decoupe en onze services derriere `gateway` (port 3100). **Pas encore deployee** : la
production tourne sur le monolithe 0.9.0. La bascule complete a ete decidee le 2026-11-16.

### Par rapport au monolithe 0.9.0 en production

- **Manga, recherche d'une serie par son titre** (SD1, SD3) : `GET /v1/search/editions`
  (editions francaises d'une serie MangaDex) et `GET /v1/series-updates` (tomes parus depuis
  l'ajout). Edition, editeur et `mangaId` entrent dans le contrat manga (SD2). Ces routes
  existent aussi sur `main` du monolithe, sans y etre deployees.
- **Manga, titre de serie d'une pre-notice BnF** : sans 461, 225$a est la collection de
  l'editeur (« Big Kana »). Il n'est retenu que s'il numerote le tome (`scanSeriesTitle`).
  Absent du monolithe.
- **Manga, editeur explicite** : ses libelles successifs, qui ne portent aucun de ses numeros,
  rejoignent l'edition (*Alice in Borderland* : 18 tomes au lieu de 4). Un catalogue qui reprend
  ses numeros (romans, 2-en-1) reste a part, dans l'enumeration comme dans la liste des
  editions. Absent du monolithe, ou le filtre reste strict.
- **LEGO** : type de collection `lego`, servi par `catalog-lego`. `rebrickable-data` porte le
  catalogue de reference : import quotidien des CSV Rebrickable, Brickset appele au scan d'un
  code absent du cache seulement, codes gardes 90 jours.
- **Jeux de societe** : `GET /v1/search/boardgame/barcode/:code` et
  `POST /v1/search/boardgame/barcode/:code/choice` (GameUPC, puis BoardGameGeek). GameUPC est
  borne a 20 jobs par minute. Tant que `BGG_API_TOKEN` est vide, aucun appel ne part vers BGG.
- **`/health/ready`** rend `503` quand la base du service ne repond pas ; `/health` reste la
  sonde de vie.
- **Banc du scan manga** : `scripts/dev.ps1 scan-resolve`, sur 35 ISBN reels, comparable au
  rapport du monolithe.

### Exploitation

- **Deploiement** : un pod Podman (`deploy/acervatim.kube`, `deploy/acervatim.yaml`), MariaDB
  et Redis hors du pod, migrations des onze schemas en initContainer (image
  `acervatim-migrate`). Procedure : `deploy/README.md`, section 3.
- **Images** : a construire sur l'architecture de l'hote. Prisma embarque le moteur de
  l'architecture du build, et une image construite ailleurs echoue au premier acces a la base.
- **Cohabitation** avec le monolithe : reseau `acervatim-services`, Redis
  `acervatim-services-redis`, port 3100. Les deux stacks tournent ensemble pendant la bascule.
- **Secrets** (gabarit `deploy/acervatim-secrets.example.yaml`) : une `DATABASE_URL_*` par
  service, `INTERNAL_PRINCIPAL_SECRET` et `INTERNAL_SERVICE_TOKEN` (appels entre services),
  `GAMEUPC_API_KEY` et `GAMEUPC_VOTER_PEPPER`, `BGG_API_TOKEN` vide. `BRICKSET_API_KEY` est
  absente a dessein tant que l'accord de Brickset est pending.
- **Reprise des donnees** : la constellation demarre sur des schemas vides. Le proxy ne
  bascule qu'apres la reprise, ecritures gelees, avec **les memes secrets** que le monolithe
  (`SUB_HASH_PEPPER`, `ENCRYPTION_KEY`, JWT) : `db/reprise/README.md`.

### Non verifie

- Aucun `podman kube play` n'a ete lance, et aucune image n'a ete construite sous Podman ni
  sur l'architecture de l'hote. Les douze images se construisent sous Docker en amd64.
- Les migrations n'ont tourne que contre des bases de developpement ou jetables.
