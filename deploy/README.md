# Deploiement - Podman Quadlet

Deploiement de la constellation sur un hote unique, en Podman **rootless**, pilote par systemd.
Meme famille de conventions que le monolithe (`../../../acervatim-backend/deploy/`) : bases UBI
9, uid 1001, reseau Podman partage, unites dans `~/.config/containers/systemd/`.

---

## 1. Ce que ce dossier contient

| Fichier | Role |
|---|---|
| [`acervatim.kube`](acervatim.kube) | **L'unite Quadlet.** Joue le manifeste, ordonne le demarrage apres la base et Redis. |
| [`acervatim.yaml`](acervatim.yaml) | **Le manifeste.** ConfigMap + Pod : 1 initContainer de migration, 10 conteneurs applicatifs. |
| [`acervatim-secrets.example.yaml`](acervatim-secrets.example.yaml) | Gabarit du Secret. La copie remplie ne se versionne pas. |
| [`acervatim-services.network`](acervatim-services.network) | Reseau Podman de la constellation. |
| [`acervatim-db.container`](acervatim-db.container) | MariaDB - une instance, onze schemas. |
| [`acervatim-services-redis.container`](acervatim-services-redis.container) | Redis - files BullMQ et cache premium. |
| [`Dockerfile.migrate`](Dockerfile.migrate) + [`migrate.sh`](migrate.sh) | Image unique qui migre les onze schemas en sequence. |
| [`build-images.ps1`](build-images.ps1) | Construit les douze images (onze services + migration). |

Les onze services deployes : `gateway`, `identity`, `billing`, `connections`, `sharing`,
`search`, `catalog-generic`, `catalog-manga`, `catalog-vinyl`, `rebrickable-data` et
`catalog-lego`. Les deux derniers forment la collection LEGO - voir le
[8](#8-lego--deux-services).

---

## 2. La topologie, et les deux decisions qui la determinent

```
                    systemd --user
              ┌──────────────────────────┬────────────────────────┐
              │ acervatim-services-redis │   acervatim.service    │
              │   (BullMQ + premium)     │   podman kube play     │
              └────────────┬─────────────┴───────────┬────────────┘
                           │                         │
                reseau podman « acervatim-services » │
                                                     │
                                 pod « acervatim » ──┘
                            ┌───────────────────────────────────────┐
                  :3100 ────┤ gateway  identity  billing  ...       │
                  (hote)    │  ── tous en localhost:31xx ──         │
                            └──────────────────┬────────────────────┘
                                               │ 3306
                            instance MariaDB du monolithe, hors de l'hote
                            (schema `acervatim` + onze schemas `acv_*`)
```

### Un seul pod pour les onze services

Ils partagent une pile reseau et se joignent en `localhost:31xx`. Trois consequences, toutes
voulues :

- **un seul port publie sur l'hote** (3100). Les dix autres services ne sont joignables que
  de l'interieur du pod, ce qui applique *par construction* l'invariant du 6 de
  l'architecture - « aucune route `/internal/*` n'est exposee vers l'exterieur » ;
- **pas de DNS a faire fonctionner** entre onze conteneurs pour un deploiement mono-hote ;
- **une seule unite a redemarrer** : jamais d'etat intermediaire ou la moitie de la
  constellation tourne dans la version precedente.

Le prix : les onze redemarrent ensemble. Acceptable tant qu'ils sont livres ensemble ; le jour
ou l'un se deploie a son rythme, il sort dans son propre pod et se joint par le reseau
partage - c'est la seule ligne a changer, de chaque cote.

### La base et Redis hors du pod

Le pod se remplace a chaque livraison. Y mettre MariaDB la ferait redemarrer a chaque
deploiement de code : un arret de service pour une raison qui ne la concerne pas, et une
fenetre de corruption a chaque fois.

C'est aussi ce qui rend les migrations propres : elles tournent en **initContainer**, donc
avant le moindre service, et `migrate.sh` attend que la base accepte les connexions avant de
commencer.

**La base est celle du monolithe** (decision D1 du 2026-11-21) : les onze schemas `acv_*`
vivent sur son instance MariaDB, hors de l'hote, a cote du schema `acervatim`, avec le meme
compte SQL. `acervatim-db.container` n'est donc pas installe en production ; il reste pour une
base locale (fin du 3). La reprise passe quand meme par un fichier de vidage : c'est aussi le
point de retour.

---

## 3. Installation : une archive, un script

L'hote n'a ni sources ni outils de build. Le poste de build produit une archive ; sur l'hote, un
script la deroule par etapes.

**Sur le poste de build** (Docker Desktop), depuis un commit etiquete `v<version>` :

```powershell
./deploy/build-archive.ps1 -Version <version>      # arm64 par defaut, sous emulation
```

Il construit les douze images, prend Redis et un client MariaDB dans la meme architecture,
controle que le `node` et les moteurs Prisma de chaque image sont bien de cette architecture (le
piege du 7), puis ecrit hors du depot `..\archives\acervatim-services-<version>-arm64\` : l'archive
`.tar` (images comprises, environ 1,3 Gio) et `deploiement.sh` a cote. `-Brouillon` accepte un
arbre modifie pour une repetition ; l'archive est alors marquee.

**Sur l'hote**, avec l'utilisateur qui fait tourner le monolithe, apres copie de ce dossier :

```sh
sh deploiement.sh acervatim-services-<version>-arm64.tar --jusqua 7   # a l'avance : monolithe intact
sh deploiement.sh acervatim-services-<version>-arm64.tar               # le jour de la bascule
sh deploiement.sh statut                                                 # a tout moment
```

| N° | Etape | Ce qui se passe |
|---|---|---|
| 0 | Verifications | architecture, Podman avec Quadlet (version minimale controlee), `systemd --user`, linger, place, memoire, port 3100 |
| 1 | Extraction | dans `~/acervatim-services/<version>/`, empreintes de `SHA256SUMS` controlees |
| 2 | Images | `podman load`, directement depuis l'archive |
| 3 | Secrets | **ceux du monolithe**, lus dans l'environnement du conteneur `acervatim-api` ; compte SQL compris ; seuls les secrets internes sont generes |
| 4 | Schemas | onze `acv_*` **sur l'instance MariaDB du monolithe**, avec son compte (ou un compte d'administration si le sien n'en a pas le droit) |
| 5 | Unites | `acervatim.kube`, Redis, reseau ; manifeste joue `~/acervatim-services/config/acervatim.yaml` (600) |
| 6 | Demarrage | Redis, puis le pod ; migrations en initContainer |
| 7 | Fumee | `deploy/tests/fumee.sh` : sondes, refus sans jeton, route admin, OpenAPI |
| 8 | Reprise | secrets compares, files du monolithe vides, `GELER`, arret de `acervatim-api`, vidage, `reprise.sh all` et `registry` |
| 9 | Relecture | `deploy/tests/relecture.js` : chaque utilisateur repris retrouve ses collections et leurs items |
| 10 | Proxy | manuel : le script dit quoi changer, attend `FAIT`, verifie l'URL publique |
| 11 | Apres | `acv_legacy` supprime, unite du monolithe mise de cote, vidage a detruire plus tard |

Une etape reussie est notee dans `~/acervatim-services/etat-<version>` : relancer le script
reprend a la premiere qui ne l'est pas. Chaque execution a son journal dans
`~/acervatim-services/journal/`, sans aucun secret. `sh deploiement.sh retour` revient au
monolithe ; `sh deploiement.sh desinstaller` retire la constellation et ses schemas avant la
bascule, sans toucher au monolithe.

**Vus au deploiement de production du 2026-11-23** (le script ne les traite pas encore) :

- **le controleur `memory` des cgroups doit etre actif.** Le manifeste fixe des limites memoire :
  un noyau demarre avec `cgroup_disable=memory` fait echouer `kube play` sur `memory.max` (code
  125). `cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers`
  doit citer `memory` ; sinon, ajouter `cgroup_enable=memory` a la ligne de commande du noyau et
  redemarrer ;
- **un reverse proxy sur une autre machine** vise l'adresse de l'hote, pas `localhost` comme le dit
  l'etape 10, et le pare-feu de l'hote doit laisser passer le port 3100 depuis cette machine ;
- **les sorties des conteneurs vont au journal** (`LogDriver=journald`) :
  `journalctl CONTAINER_NAME=acervatim-<service>` les montre, avec `sudo` si le compte n'a pas
  acces au journal systeme. `journalctl --user`, que le script conseille, ne montre rien quand le
  journal n'est pas reparti par compte ;
- **ne pas couper un premier demarrage.** Apres un redemarrage de l'hote, l'unite demarre seule
  (linger) et joue les migrations. Relancer le script ou arreter l'unite pendant ce temps peut
  couper une premiere migration : Prisma la note commencee sans fin et refuse ensuite toute
  migration du schema (P3009), et le pod ne demarre plus. Remede, sur un schema encore vide :
  supprimer ses tables et `_prisma_migrations`, puis relancer le script.

**Le manifeste joue vit dans `~/acervatim-services/config/`, jamais dans le depot**, parce qu'il
porte les secrets. `deploiement.sh` le recompose a l'etape 5.

**Variante base locale** (developpement, essai isole) : `acervatim-db.container` reste
disponible. Il faut alors l'installer, ajouter `acervatim-db.service` aux `Requires=` et `After=`
de `acervatim.kube`, et pointer les `DATABASE_URL_*` sur `acervatim-db`.

### Verification

```bash
systemctl --user status acervatim
podman pod ps
curl -s -o ready.json -w '%{http_code}\n' localhost:3100/health/ready   # attendu : 200
jq -e '.status == "ok"' ready.json                                     # attendu : true
```

`curl -s` seul rend 0 meme sur un `503` : c'est le code HTTP qui compte. `/health/ready` du
gateway repond `503` si sa base ne repond pas en 2 s, `200` sinon. Il interroge la sonde de
disponibilite (`/health/ready`, pas `/health`) des huit services qu'il route : la partie de la
constellation que l'app atteint est complete quand il repond `200` **et** `"status": "ok"` ;
`degraded` signale un service aval pas pret ou Redis absent (detail dans `services[]`). Il expose
aussi le contenu du registre de routage ; le nombre de suppressions RGPD non terminees est dans
le `/health/ready` d'`identity`, pas dans celui du gateway.

Chaque service repond de la meme facon sur sa propre sonde : `503` quand sa base ne repond pas en
2 s, `200` sinon. `/health` reste la sonde de vie : elle ne touche aucune dependance, et c'est
elle que visent les `HEALTHCHECK` des images.

`rebrickable-data` n'y figure pas : le gateway ne le route pas, et son port 3190 n'est pas
publie. Il se sonde de l'interieur du pod, avec le `node` de son image (sans `curl`) :

```bash
podman exec acervatim-rebrickable-data node -e \
  "fetch('http://localhost:3190/health/ready').then(r => r.text().then(t => console.log(r.status, t)))"
# 200 {"status":"ok","db":true,"redis":true,"sets":<nombre>,"brickset":false}
```

`sets` a `0` : aucun import n'a encore abouti (voir le 8). `brickset` a `false` : attendu tant que
l'accord de Brickset n'est pas obtenu.

---

## 4. Migrations

Une image unique, `acervatim-migrate`, porte les onze dossiers `prisma/` et les joue en
sequence ([`migrate.sh`](migrate.sh)). Le monolithe utilisait une cible `--target migrate` dans
son propre Dockerfile ; a onze services, cela ferait onze images de plus pour onze invocations
d'un meme CLI - et surtout, cela ne garantirait plus l'**ordre**.

Elle tourne en `initContainer` : **son echec empeche le pod de demarrer**, ce qui est
infiniment preferable a onze services tournant sur un schema a moitie migre.

`rebrickable-data` (`acv_rebrickable`, variable `DATABASE_URL_REBRICKABLE_DATA`) puis
`catalog-lego` (`acv_cat_lego`, variable `DATABASE_URL_CATALOG_LEGO`) passent en dernier. Comme
les autres, ils utilisent le compte SQL unique `acervatim` : la separation des comptes par service est reportee, l'isolation des schemas reste
une convention.

Le script attend que MariaDB accepte les connexions avant de commencer (`DB_WAIT_SECONDS`,
60 s par defaut) : systemd garantit que le conteneur est *demarre*, pas qu'il est *pret*.

Un `DATABASE_URL_*` absent fait ignorer ce service au lieu de tout arreter - la constellation
doit pouvoir se deployer partiellement. Le service concerne echouera de lui-meme, bruyamment,
au premier acces.

Diagnostic hors pod :

```bash
podman run --rm --network acervatim-services -e DB_HOST=<instance> \
  -e DATABASE_URL_IDENTITY='mysql://acervatim:...@<instance>:3306/acv_core' \
  localhost/acervatim-migrate:0.1.0
```

(Les URL completes sont dans `~/acervatim-services/config/acervatim-secrets.yaml` ; `-e` sur une
ligne de commande les rend lisibles dans la liste des processus : diagnostic ponctuel seulement.)

Une variable par schema a migrer ; celles qui manquent sont ignorees, ce qui permet de rejouer
un seul service.

---

## 5. Empreinte memoire - la reserve du TL;DR de l'architecture

Le manifeste declare des `requests` et des `limits` par conteneur. Podman applique les
**limites** (`--memory`) ; les `requests` sont la pour documenter l'attendu au repos et pour
un vrai cluster.

| | requests | limits |
|---|---|---|
| gateway, identity, connections, catalog-generic, catalog-manga, catalog-vinyl | 160 Mi × 6 | 256 Mi × 6 |
| billing (SDK Google) | 192 Mi | 320 Mi |
| sharing | 144 Mi | 224 Mi |
| search (6 files BullMQ, parseur UNIMARC, 6 adapters) | 288 Mi | 512 Mi |
| rebrickable-data (import des CSV Rebrickable) | 192 Mi | 320 Mi |
| **total applicatif** | **≈ 1,7 Gi** | **≈ 2,8 Gi** |

Plus MariaDB et Redis, hors pod et non plafonnes ici.

**Ces chiffres sont une estimation, pas une mesure** - sauf ceux de `rebrickable-data`, poses
sur une mesure du 2026-11-16 en image de production sous Docker (detail en commentaire du
manifeste) : 120 a 140 Mo de RSS catalogue vide, ~160 Mo au repos apres import, et un pic de
186 Mo pendant un reimport, sur des CSV synthetiques plus gros que le catalogue reel. Sa limite
est large a dessein : un OOM pendant l'import de demarrage le ferait recommencer a chaque
redemarrage tant que le catalogue reste vide.

L'architecture est explicite : le passage de palier doit etre justifie par une mesure (§4), et
elle estimait 1 a 1,4 Go de RSS au repos pour huit processus. La premiere chose a faire apres
un demarrage reussi est de comparer :

```bash
podman stats --no-stream
```

Si le total au repos depasse nettement les `requests` cumules, ce sont les `limits` qu'il faut
revoir - pas la mesure.

Aucune limite CPU n'est declaree : la memoire est la contrainte que l'architecture pointe, et
brider le CPU de onze processus Node ne ferait qu'allonger un demarrage deja long.

---

## 6. Cohabitation avec le monolithe

Tout est nomme distinctement pour que les deux stacks tournent en parallele pendant la bascule :

| | Monolithe | Constellation |
|---|---|---|
| Reseau | `acervatim` | `acervatim-services` |
| Redis | `acervatim-redis` | `acervatim-services-redis` |
| Volume Redis | `acervatim-redis-data` | `acervatim-services-redis-data` |
| Port publie | 3000 | 3100 |
| Unites | `acervatim-api`, `acervatim-redis` | `acervatim`, `acervatim-services-redis` |
| Base | schema `acervatim` | schemas `acv_*`, sur la meme instance, avec le meme compte |
| Dossier | `~/acervatim/` | `~/acervatim-services/` |

Les unites Quadlet prennent le nom de leur fichier : c'est pourquoi le Redis de la
constellation s'appelle `acervatim-services-redis.container`. Un fichier
`acervatim-redis.container` copie a l'etape 6 du 3 remplacerait celui du monolithe, deja
installe sur l'hote.

Cote app, la bascule se resume a faire pointer le reverse proxy de 3000 vers 3100 : le contrat
`/v1/*` est identique, c'est toute la contrainte du decoupage. **Cote donnees, non** : la
constellation demarre sur onze schemas vides. Le proxy ne se bascule qu'apres la reprise des
donnees du monolithe, ecritures gelees, et avec les memes secrets -
[`../db/reprise/README.md`](../db/reprise/README.md) donne la procedure et le retour arriere.

La reprise ne concerne ni `acv_rebrickable` ni `acv_cat_lego` : le monolithe n'a aucune donnee
LEGO (ni table, ni type de collection). Le premier se remplit seul, par l'import des CSV
Rebrickable au premier demarrage ; le second demarre vide, et seules les collections creees
apres la bascule y entrent. L'ancienne stack autonome de `catalog-lego` n'a jamais tourne en
production : rien n'est a reprendre d'elle. `reprise.sh reset-targets` ne touche aucun des deux.

---

## 7. Ce qui n'a pas ete verifie

**Verifie le 2026-11-23, en production** : l'archive arm64, construite sous emulation, deroulee
par `deploiement.sh` sur l'hote, etapes 0 a 11. Les onze schemas sont migres sur l'instance
MariaDB du monolithe, dont la version est plus ancienne que celle du developpement, et les onze
services sont prets (`fumee.sh` vert). Les secrets sont repris du conteneur du monolithe, la
reprise du vidage de production est conforme, et `relecture.js` retrouve les collections et les
items de chaque utilisateur. Le reverse proxy bascule vers le port 3100, et l'adresse publique
sert la constellation. Ensuite, l'app lit collections et items (pagination comprise) sur deux
comptes.

**Verifie le 2026-11-16, pour l'entree de `rebrickable-data`**, sous Docker sur un poste de
developpement amd64, dans un projet compose jetable dont le reseau n'a aucune sortie :

- son image de production et `acervatim-migrate` se construisent (`build-images.ps1 -Engine
  docker -Only rebrickable-data,migrate`, sous PowerShell 5.1) ;
- `migrate.sh`, avec les dix `DATABASE_URL_*` du gabarit, sur une MariaDB 10.11 vierge
  initialisee par `db/init` : dix schemas migres, dont `acv_rebrickable` (2 migrations, 4
  tables ; une troisieme, du 2026-11-17, ajoute la date des codes-barres), puis un second
  passage sans migration en attente ;
- le conteneur, avec l'environnement que le pod lui donne (ConfigMap + Secret du gabarit, puis
  `PORT` et `DATABASE_URL`) : `/health` et `/health/ready` en `200`, import en `failed` faute
  de reseau, campagne Brickset `skipped` (le moissonnage a ete retire le 2026-11-17 : Brickset
  n'est plus appele qu'au scan), `BRICKSET_API_KEY absent` au journal ;
- `acervatim.yaml` et le gabarit de secrets se lisent comme du YAML (seuls et concatenes), et
  chaque `secretKeyRef` du Pod a sa cle dans le gabarit.

**Verifie le 2026-11-21, en repetition** : l'archive amd64 deroulee par `deploiement.sh`, sous
Podman rootless dans une distribution WSL dediee, avec le monolithe de la production (reconstruit
depuis son etiquette) en service sur une instance MariaDB distincte (adresse factice, compte
limite a `acervatim`), et un nginx local en guise de reverse proxy :

- premier `podman kube play` du manifeste par Quadlet : `hostPort`, `envFrom.secretRef`,
  `secretKeyRef` et `initContainers` ensemble ; les onze schemas migres sur l'instance distante ;
  les onze services prets, `fumee.sh` vert (18 controles) ;
- secrets repris de l'environnement du conteneur du monolithe, empreintes identiques ; chemin du
  compte d'administration a l'etape 4 ; reprise conforme (22 tables, 5 invariants, registre de
  18 entrees), `relecture.js` et `parcours.js` conformes ; bascule du proxy ; puis `retour` et
  `desinstaller`, base du monolithe identique a la somme de controle pres ;
- trois defauts trouves et corriges : `migrate.sh` en CRLF dans l'image (arbre de travail
  Windows), des cles vides refusees par `billing` (`GOOGLE_PLAY_*`), un `podman run -i` qui
  mangeait les reponses tapees. Note : quinze redemarrages du pod enchaines en pleine
  initialisation ont laisse 150 connexions orphelines sur l'instance (refus `1040`) ; un
  redemarrage normal n'en laisse aucune. L'etape 4 releve la marge de connexions.

A dire clairement, parce que rien de ce qui suit n'a ete controle :

- **Le LEGO en production** : ni la recherche d'une boite a travers le gateway, ni la
  suppression d'un compte qui efface ses donnees LEGO.
- **L'import des vrais CSV de Rebrickable en image de production** : il a ete controle en
  developpement (README racine, 6), et sa memoire mesuree sur des CSV synthetiques.
- **La memoire et la latence sous Podman**, et la saga RGPD avec un service arrete.
- **`readOnlyRootFilesystem` n'est pas active**, alors qu'il est desormais a portee :
  l'ecriture d'`openapi.json` au bootstrap a ete restreinte au developpement. Ce qui reste a
  verifier est ce que Prisma ecrit dans `/tmp` a l'execution. Un `emptyDir` monte sur `/tmp`
  suffirait probablement.

---

## 8. LEGO : deux services

La collection LEGO tient en deux services : `rebrickable-data`, le catalogue de reference
partage par tous (sans donnee d'utilisateur), et `catalog-lego`, les collections des
utilisateurs. La recherche d'un set passe par `search`, qui lit `rebrickable-data`.

### 8.1 `rebrickable-data` : le catalogue de reference

Le catalogue LEGO de reference (sets, themes, figurines, codes-barres) est un conteneur
du pod : port 3190 **non publie**, schema `acv_rebrickable`, secret
`DATABASE_URL_REBRICKABLE_DATA`, migre en dernier par `acervatim-migrate`, construit par
`build-images.ps1`. Il n'a **aucune route au gateway** : seulement `/internal/*`
(`INTERNAL_SERVICE_TOKEN`), `/admin/*` (`ADMIN_API_TOKEN`) et `/health*`, joignables du pod.

**Ses sorties.** Au premier demarrage sur un catalogue vide, puis chaque jour a 03:00 UTC, il
telecharge les quatre CSV publics de la page Downloads de Rebrickable
(`REBRICKABLE_DOWNLOADS_URL`, sans cle, sous controle `Last-Modified`). C'est sa seule sortie :
le pod doit pouvoir joindre `cdn.rebrickable.com` en HTTPS. Si l'import echoue, le service
demarre quand meme et repond vide (`"sets": 0`) jusqu'au passage suivant - 03:00 UTC, ou le
prochain demarrage du pod tant que le catalogue est vide - ou jusqu'a un import lance a la
main :

```bash
# Etat : comptes, derniers imports, budget Brickset (le jeton est deja dans l'environnement)
podman exec acervatim-rebrickable-data node -e "fetch('http://localhost:3190/admin/status', \
  { headers: { Authorization: 'Bearer ' + process.env.ADMIN_API_TOKEN } }).then(r => r.text()).then(console.log)"
# Import (sans `?force`, il rend `unchanged` si les CSV n'ont pas bouge). Au plus une fois par
# jour : c'est la regle des CGU de Rebrickable pour l'automatisation.
podman exec acervatim-rebrickable-data node -e "fetch('http://localhost:3190/admin/import/rebrickable', \
  { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.ADMIN_API_TOKEN } }).then(r => r.text()).then(console.log)"
```

**Brickset : pas de cle.** L'accord de Brickset pour l'usage de ses codes-barres est
`pending` ; `BRICKSET_API_KEY` est donc **absente du Secret, a dessein**. Sans elle, le service
sert le catalogue sans EAN/UPC, n'appelle jamais Brickset, le journalise
(`BRICKSET_API_KEY absent`), rend `"brickset": false` sur `/health/ready`, et un scan rend
`lookup: 'disabled'`. Le jour ou l'accord est ecrit : ajouter la cle au Secret, regenerer le
manifeste joue (3, etape 5), redemarrer le pod. Brickset ne sera alors appele qu'au scan d'un
code absent du cache, un appel au plus par code et 90 par jour UTC ; les codes sont gardes
90 jours puis effaces par le passage quotidien, et un code que Brickset ne connait pas est
redemande apres 7 jours. Il n'y a plus de moissonnage, et
`rebrickable-data` est le seul service qui recoit cette cle.

**Saga RGPD : non participant, et c'est juste.** Son schema (`api_cache` - le compteur de
budget Brickset et les codes inconnus, sans trace de qui a scanne -, `lego_themes`,
`lego_sets`, `import_runs`) ne porte aucun `userId`, et il
n'expose pas `/internal/users/:id/*`. L'inscrire dans `SAGA_PARTICIPANTS` laisserait a chaque
suppression de compte un job `failed`, rejoue toutes les 15 minutes sur une route qui n'existe
pas.

**Reprise des donnees : non concerne** - voir le 6.

**Son consommateur : `search`**, par `REBRICKABLE_DATA_BASE_URL` (ConfigMap), pour
`GET /v1/search?type=lego` (texte et code-barres) et pour le snapshot d'une source
`rebrickable`. Le gateway ne le route pas et ne le sonde pas.

### 8.2 `catalog-lego` : les collections LEGO

Refait le 2026-11-17 sur `catalog-core`, comme clone de `catalog-vinyl` : port 3220 **non
publie**, schema `acv_cat_lego`, secret `DATABASE_URL_CATALOG_LEGO`, migre en dernier par
`acervatim-migrate`, image construite par `build-images.ps1`. Le gateway le route par
`CATALOG_LEGO_BASE_URL` (type de collection `lego`, ajoute a `identity` par une migration), et
il figure dans `SAGA_PARTICIPANTS`.

Il n'a **aucune cle** : ni Rebrickable, ni Brickset, ni cle personnelle d'utilisateur.
L'ancienne stack autonome (index local rempli par l'API Rebrickable, moissonneurs, cles
personnelles chiffrees) a ete supprimee ; elle n'avait jamais ete deployee.

**Saga RGPD : participant.** Ses collections et ses items portent un `userId` ; la saga les
exporte puis les purge par `DELETE /internal/users/:id/data`, comme pour les autres catalogs.
