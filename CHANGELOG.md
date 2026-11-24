# Changelog

Evolutions notables de la constellation Acervatim. Format inspire de
[Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) ; versionnage
[SemVer](https://semver.org/lang/fr/). Le numero est porte par les `package.json` des douze
paquets et par les tags d'image epingles dans `deploy/acervatim.yaml` : les deux changent
ensemble (`deploy/build-images.ps1 -Tag <version>`).

## [0.1.0] - 2026-11-21

Premiere version de la constellation : le contrat `/v1/*` du monolithe `acervatim-backend`,
decoupe en onze services derriere `gateway` (port 3100). **En production depuis le
2026-11-23**, a la place du monolithe 0.9.0 (bascule complete decidee le 2026-11-16) : l'archive
arm64 de cette etiquette, deroulee sur l'hote par `deploiement.sh`. Le monolithe est arrete, son
unite mise de cote : `deploiement.sh retour` le relance pendant la fenetre de retour.

### Par rapport au monolithe 0.9.0, qu'elle remplace en production

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

- **Deploiement de production le 2026-11-23**, sur l'hote arm64 sous Podman rootless : etapes 0 a
  11 de `deploiement.sh`. Les onze schemas sont migres sur l'instance MariaDB du monolithe (10.3,
  plus ancienne que celle du developpement), les onze services sont prets, `fumee.sh` est vert.
  La reprise des donnees de production et leur relecture au nom de chaque utilisateur sont
  conformes, et le reverse proxy sert la constellation par le port 3100. Premieres lectures
  depuis l'app (collections, items, pagination) servies sur deux comptes.
- Repetition complete le 2026-11-21 sous Podman rootless, dans une distribution WSL dediee, en
  amd64 : monolithe 0.9.0 en service sur une instance MariaDB distincte, etapes 0 a 11, puis
  `retour` et `desinstaller` (base du monolithe identique a la somme de controle pres). Premier
  `podman kube play` du manifeste : initContainer, `hostPort`, `envFrom` et Secret fonctionnent.
- Les douze images se construisent sous Docker en amd64, et en arm64 sous emulation (archive de
  1 375 Mio, 110 minutes de construction).

### Non verifie

- En production : la recherche d'une boite LEGO a travers le gateway, et la suppression d'un
  compte qui efface ses donnees LEGO.
- La saga RGPD avec un service arrete, et les mesures de memoire et de latence sous Podman.
- Brickset avec une vraie cle (`BRICKSET_API_KEY` absente, accord pending) et BoardGameGeek
  (`BGG_API_TOKEN` vide, jeton pending).

### Problemes connus

Trouves au deploiement du 2026-11-23, a corriger dans une version suivante.

- **Etape 6 et premier demarrage** : l'etape 6 relance l'unite meme quand elle demarre deja
  (lancee au boot par le linger). Le 2026-11-23, cette relance a coupe la premiere migration
  d'`acv_cat_lego` : Prisma l'a notee commencee sans fin, puis a refuse toute migration du schema
  (P3009), et le pod ne demarrait plus. Remede, sur un schema encore vide : supprimer ses tables
  et `_prisma_migrations`, puis relancer le script.
- **Controleur memoire des cgroups** : un noyau demarre avec `cgroup_disable=memory` fait echouer
  `kube play` sur `memory.max` (code 125), parce que le manifeste fixe des limites memoire. Il
  faut `cgroup_enable=memory` a la ligne de commande du noyau ; l'etape 0 ne le controle pas.
- **Diagnostic** : quand le journal n'est pas reparti par compte, `journalctl --user`, que le
  script conseille, ne montre rien. Les sorties d'un conteneur se lisent par
  `journalctl CONTAINER_NAME=<conteneur>`, avec `sudo` si le compte n'a pas acces au journal.
- **Etape 10** : le message suppose un reverse proxy sur l'hote (`localhost:3000`). Un proxy sur
  une autre machine vise l'adresse de l'hote, dont le pare-feu doit laisser passer le port 3100.
- **`sharing` interroge les quatre catalogs a chaque requete sur une collection** pour en trouver
  le proprietaire (`GET /internal/collections/:id/owner`), et pas seulement a la creation d'un
  partage comme le dit son code. Les trois catalogs qui ne l'ont pas repondent `404` et l'ecrivent
  en `WARN` : rien n'echoue, mais trois appels internes sont de trop. Le gateway connait le type
  par son registre et pourrait le transmettre.
