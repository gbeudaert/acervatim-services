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

- **Deploiement par archive** : `deploy/build-archive.ps1` construit sur le poste de build une
  archive par architecture (les douze images, Redis et un client MariaDB) ; `deploy/deploiement.sh`
  la deroule sur l'hote en douze etapes notees, avec reprise apres interruption, une pause pour la
  bascule du reverse proxy, et les sous-commandes `statut`, `retour` et `desinstaller`.
  Procedure : `deploy/README.md`, section 3. Tests : `deploy/tests/fumee.sh` (sans donnees) et
  `deploy/tests/relecture.js` (donnees reprises, lues au nom de chaque utilisateur).
- **Pod Podman** (`deploy/acervatim.kube`, `deploy/acervatim.yaml`) : migrations des onze schemas
  en initContainer (image `acervatim-migrate`), Redis hors du pod.
- **Base sur l'instance MariaDB du monolithe** (decision du 2026-11-21) : onze schemas `acv_*` a
  cote de `acervatim`, avec le compte du monolithe ; `acervatim-db.container` ne sert plus qu'en
  local. `reprise.sh` joint une instance distante par un client en conteneur (`TARGET_DB_HOST`,
  `SOURCE_DB_HOST`).
- **Images** : a construire sur l'architecture de l'hote. Prisma embarque le moteur de
  l'architecture du build, et une image construite ailleurs echoue au premier acces a la base.
  L'archive controle chaque image : node et moteurs Prisma de l'architecture visee, scripts
  shell en LF (`.gitattributes` l'impose ; construite depuis un arbre de travail Windows, l'image
  de migration gardait `migrate.sh` en CRLF et l'initContainer ne demarrait pas).
- **Cohabitation** avec le monolithe : reseau `acervatim-services`, Redis
  `acervatim-services-redis`, port 3100. Les deux stacks tournent ensemble pendant la bascule.
- **Secrets** : repris par `deploiement.sh` de l'environnement du conteneur du monolithe en
  service, compte SQL compris ; seuls `INTERNAL_PRINCIPAL_SECRET`, `INTERNAL_SERVICE_TOKEN` et
  `GAMEUPC_VOTER_PEPPER` sont generes, et `GAMEUPC_API_KEY` est saisie. Une cle absente du
  monolithe reste hors du Secret : une valeur vide echoue a la validation (`billing` sur
  `GOOGLE_PLAY_*`). Gabarit : `deploy/acervatim-secrets.example.yaml`. `BGG_API_TOKEN` vide,
  `BRICKSET_API_KEY` absente a dessein tant que l'accord de Brickset est pending.
- **Reprise des donnees** : la constellation demarre sur des schemas vides. Le proxy ne
  bascule qu'apres la reprise, ecritures gelees, avec **les memes secrets** que le monolithe
  (`SUB_HASH_PEPPER`, `ENCRYPTION_KEY`, JWT) : etapes 8 a 10 de `deploiement.sh`,
  `db/reprise/README.md`.

### Verifie

- Repetition complete le 2026-11-21 sous Podman rootless, dans une distribution WSL dediee, en
  amd64 : monolithe 0.9.0 en service sur une instance MariaDB distincte, etapes 0 a 11, puis
  `retour` et `desinstaller` (base du monolithe identique a la somme de controle pres). Premier
  `podman kube play` du manifeste : initContainer, `hostPort`, `envFrom` et Secret fonctionnent.
- Les douze images se construisent sous Docker en amd64.

### Non verifie

- Rien n'a tourne sur l'hote : l'arm64, l'instance MariaDB et le reverse proxy reels restent a
  eprouver. Les etapes 0 a 7 le font sans toucher au monolithe.
- La reprise n'a tourne que sur le vidage de developpement, jamais sur les donnees de production.
