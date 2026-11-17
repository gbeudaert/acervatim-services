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
| [`acervatim-db.container`](acervatim-db.container) | MariaDB - une instance, dix schemas. |
| [`acervatim-redis.container`](acervatim-redis.container) | Redis - files BullMQ et cache premium. |
| [`Dockerfile.migrate`](Dockerfile.migrate) + [`migrate.sh`](migrate.sh) | Image unique qui migre les dix schemas en sequence. |
| [`build-images.ps1`](build-images.ps1) | Construit les onze images (dix services + migration). |

Les dix services deployes : `gateway`, `identity`, `billing`, `connections`, `sharing`,
`search`, `catalog-generic`, `catalog-manga`, `catalog-vinyl` et `rebrickable-data`.
**`catalog-lego` n'en fait pas encore partie** : il doit etre refait, puis entrer dans le
deploiement avant la bascule - voir le
[8](#8-lego--ce-qui-est-deploye-et-ce-qui-reste-a-faire-avant-la-bascule).

---

## 2. La topologie, et les deux decisions qui la determinent

```
                    systemd --user
  ┌──────────────────────┬─────────────────────┬────────────────────────┐
  │ acervatim-db.service │ acervatim-redis.svc │   acervatim.service    │
  │ (MariaDB, 10 schemas)│  (BullMQ + premium) │   podman kube play     │
  └──────────┬───────────┴──────────┬──────────┴───────────┬────────────┘
             │                      │                      │
             └────── reseau podman « acervatim-services » ──┘
                                                            │
                                    pod « acervatim » ──────┘
                            ┌───────────────────────────────────────┐
                  :3100 ────┤ gateway  identity  billing  ...       │
                  (hote)    │  ── tous en localhost:31xx ──         │
                            └───────────────────────────────────────┘
```

### Un seul pod pour les dix services

Ils partagent une pile reseau et se joignent en `localhost:31xx`. Trois consequences, toutes
voulues :

- **un seul port publie sur l'hote** (3100). Les neuf autres services ne sont joignables que
  de l'interieur du pod, ce qui applique *par construction* l'invariant du 6 de
  l'architecture - « aucune route `/internal/*` n'est exposee vers l'exterieur » ;
- **pas de DNS a faire fonctionner** entre dix conteneurs pour un deploiement mono-hote ;
- **une seule unite a redemarrer** : jamais d'etat intermediaire ou la moitie de la
  constellation tourne dans la version precedente.

Le prix : les dix redemarrent ensemble. Acceptable tant qu'ils sont livres ensemble ; le jour
ou l'un se deploie a son rythme, il sort dans son propre pod et se joint par le reseau
partage - c'est la seule ligne a changer, de chaque cote.

### La base et Redis hors du pod

Le pod se remplace a chaque livraison. Y mettre MariaDB la ferait redemarrer a chaque
deploiement de code : un arret de service pour une raison qui ne la concerne pas, et une
fenetre de corruption a chaque fois.

C'est aussi ce qui rend les migrations propres : elles tournent en **initContainer**, donc
avant le moindre service, et la base est deja prete parce que systemd l'a demarree avant
(`Requires=` + `After=`).

Si la base est deportee sur un NAS, comme pour le monolithe : ne pas installer
`acervatim-db.container` et pointer les `DATABASE_URL_*` vers l'hote distant. Rien d'autre ne
change.

---

## 3. Installation

```bash
# 1. Les images (sur l'hote de deploiement : Prisma genere l'engine de l'arch du BUILD)
./deploy/build-images.ps1

# 2. Le dossier de deploiement
mkdir -p ~/acervatim/db-init
cp db/init/01-schemas.sql ~/acervatim/db-init/

# 3. Le mot de passe de la base
cat > ~/acervatim/db.env <<'EOF'
MARIADB_ROOT_PASSWORD=...
MARIADB_PASSWORD=...
EOF
chmod 600 ~/acervatim/db.env

# 4. Les secrets applicatifs
cp deploy/acervatim-secrets.example.yaml ~/acervatim/acervatim-secrets.yaml
chmod 600 ~/acervatim/acervatim-secrets.yaml
$EDITOR ~/acervatim/acervatim-secrets.yaml

# 5. Le manifeste joue = secrets + manifeste
cat ~/acervatim/acervatim-secrets.yaml deploy/acervatim.yaml > ~/acervatim/acervatim.yaml
chmod 600 ~/acervatim/acervatim.yaml

# 6. Les unites
cp deploy/*.network deploy/*.container deploy/*.kube ~/.config/containers/systemd/
systemctl --user daemon-reload

# 7. Demarrage
systemctl --user start acervatim-db acervatim-redis
systemctl --user start acervatim

# 8. Survie hors session SSH - sans ca, tout s'arrete a la deconnexion
loginctl enable-linger $USER
```

**Le manifeste joue vit dans `~/acervatim/`, pas dans le depot**, parce qu'il porte les
secrets. Le regenerer (etape 5) apres toute modification de `deploy/acervatim.yaml`.

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

Une image unique, `acervatim-migrate`, porte les dix dossiers `prisma/` et les joue en
sequence ([`migrate.sh`](migrate.sh)). Le monolithe utilisait une cible `--target migrate` dans
son propre Dockerfile ; a dix services, cela ferait dix images de plus pour dix invocations
d'un meme CLI - et surtout, cela ne garantirait plus l'**ordre**.

Elle tourne en `initContainer` : **son echec empeche le pod de demarrer**, ce qui est
infiniment preferable a dix services tournant sur un schema a moitie migre.

`rebrickable-data` passe en dernier (`acv_rebrickable`, variable
`DATABASE_URL_REBRICKABLE_DATA`). Comme les neuf autres, il utilise le compte SQL unique
`acervatim` : la separation des comptes par service est reportee, l'isolation des schemas reste
une convention.

Le script attend que MariaDB accepte les connexions avant de commencer (`DB_WAIT_SECONDS`,
60 s par defaut) : systemd garantit que le conteneur est *demarre*, pas qu'il est *pret*.

Un `DATABASE_URL_*` absent fait ignorer ce service au lieu de tout arreter - la constellation
doit pouvoir se deployer partiellement. Le service concerne echouera de lui-meme, bruyamment,
au premier acces.

Diagnostic hors pod :

```bash
podman run --rm --network acervatim-services \
  -e DATABASE_URL_IDENTITY='mysql://acervatim:...@acervatim-db:3306/acv_core' \
  localhost/acervatim-migrate:0.1.0
```

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
brider le CPU de dix processus Node ne ferait qu'allonger un demarrage deja long.

---

## 6. Cohabitation avec le monolithe

Tout est nomme distinctement pour que les deux stacks tournent en parallele pendant la bascule :

| | Monolithe | Constellation |
|---|---|---|
| Reseau | `acervatim` | `acervatim-services` |
| Redis | `acervatim-redis` | `acervatim-services-redis` |
| Volume Redis | `acervatim-redis-data` | `acervatim-services-redis-data` |
| Port publie | 3000 | 3100 |
| Unites | `acervatim-api`, `acervatim-redis` | `acervatim`, `acervatim-db`, `acervatim-redis` |

Cote app, la bascule se resume a faire pointer le reverse proxy de 3000 vers 3100 : le contrat
`/v1/*` est identique, c'est toute la contrainte du decoupage. **Cote donnees, non** : la
constellation demarre sur dix schemas vides. Le proxy ne se bascule qu'apres la reprise des
donnees du monolithe, ecritures gelees, et avec les memes secrets -
[`../db/reprise/README.md`](../db/reprise/README.md) donne la procedure et le retour arriere.

La reprise ne concerne pas `acv_rebrickable` : le monolithe n'a aucune donnee LEGO (ni table,
ni type de collection), et ce schema se remplit seul, par l'import des CSV Rebrickable au
premier demarrage. `reprise.sh reset-targets` n'y touche pas non plus.

---

## 7. Ce qui n'a pas ete verifie

**Verifie le 2026-11-16, pour l'entree de `rebrickable-data`**, sous Docker sur un poste de
developpement amd64, dans un projet compose jetable dont le reseau n'a aucune sortie :

- son image de production et `acervatim-migrate` se construisent (`build-images.ps1 -Engine
  docker -Only rebrickable-data,migrate`, sous PowerShell 5.1) ;
- `migrate.sh`, avec les dix `DATABASE_URL_*` du gabarit, sur une MariaDB 10.11 vierge
  initialisee par `db/init` : dix schemas migres, dont `acv_rebrickable` (2 migrations, 4
  tables), puis un second passage sans migration en attente ;
- le conteneur, avec l'environnement que le pod lui donne (ConfigMap + Secret du gabarit, puis
  `PORT` et `DATABASE_URL`) : `/health` et `/health/ready` en `200`, import en `failed` faute
  de reseau, campagne Brickset `skipped`, `BRICKSET_API_KEY absent` au journal ;
- `acervatim.yaml` et le gabarit de secrets se lisent comme du YAML (seuls et concatenes), et
  chaque `secretKeyRef` du Pod a sa cle dans le gabarit.

A dire clairement, parce que rien de ce qui suit n'a tourne :

- **Aucune image n'a ete construite sous Podman**, ni sur l'architecture de l'hote de
  deploiement : seulement sous Docker, en amd64 (pour la mesure memoire du 2026-11-14, puis
  `rebrickable-data` et `acervatim-migrate` ci-dessus).
- **Aucun `podman kube play` n'a ete lance.** Le manifeste est ecrit contre le comportement
  documente de Podman ; `hostPort` dans un pod, `envFrom.secretRef` et `initContainers` sont
  des fonctionnalites supportees, mais leur combinaison exacte reste a eprouver.
- **Les migrations n'ont ete jouees que contre des bases de developpement ou jetables**, jamais
  contre celle de l'hote. Elles sont ecrites a la main, pas generees par `prisma migrate dev`.
  Le premier demarrage est le vrai test - et c'est precisement pour cela qu'elles echouent
  bruyamment plutot que silencieusement.
- **L'import des vrais CSV de Rebrickable n'a pas tourne en image de production** : il a tourne
  en developpement (README racine, 6), et sa memoire a ete mesuree sur des CSV synthetiques.
- **`readOnlyRootFilesystem` n'est pas active**, alors qu'il est desormais a portee :
  l'ecriture d'`openapi.json` au bootstrap a ete restreinte au developpement. Ce qui reste a
  verifier est ce que Prisma ecrit dans `/tmp` a l'execution. Un `emptyDir` monte sur `/tmp`
  suffirait probablement.

---

## 8. LEGO : ce qui est deploye, et ce qui reste a faire avant la bascule

### 8.1 `rebrickable-data` est deploye

Le catalogue LEGO de reference (sets, themes, figurines, codes-barres) est le dixieme conteneur
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

**Brickset : pas de cle.** L'accord de Brickset pour l'usage de ses codes-barres n'est pas
obtenu ; `BRICKSET_API_KEY` est donc **absente du Secret, a dessein**. Sans elle, le service
sert le catalogue sans EAN/UPC, n'appelle jamais Brickset, le journalise
(`BRICKSET_API_KEY absent`) et rend `"brickset": false` sur `/health/ready`. Le jour ou
l'accord est ecrit : ajouter la cle au Secret, regenerer le manifeste joue (3, etape 5),
redemarrer le pod. `catalog-lego` n'etant pas deploye, `rebrickable-data` sera son seul
moissonneur : la question du quota partage entre deux moissonneurs (README racine) ne se pose
pas en production.

**Saga RGPD : non participant, et c'est juste.** Son schema (`api_cache` - le seul compteur
de budget Brickset -, `lego_themes`, `lego_sets`, `import_runs`) ne porte aucun `userId`, et il
n'expose pas `/internal/users/:id/*`. L'inscrire dans `SAGA_PARTICIPANTS` laisserait a chaque
suppression de compte un job `failed`, rejoue toutes les 15 minutes sur une route qui n'existe
pas.

**Reprise des donnees : non concerne** - voir le 6.

**Pas encore de consommateur.** Aucun service du pod n'appelle ses routes `/internal/*`
aujourd'hui : aucune variable d'adresse ne le designe dans le code des neuf autres, le gateway
ne le route pas et ne le sonde pas. Il constitue et tient a jour la base de reference, et
personne ne la lit tant que le catalog LEGO n'est pas la (8.2). D'ou l'absence de
`REBRICKABLE_DATA_BASE_URL`
dans le ConfigMap : elle s'ajoutera avec son premier consommateur.

### 8.2 `catalog-lego` n'est pas encore deploye

**`catalog-lego` n'est pas dans le deploiement, et il doit y entrer avant la bascule**
(decision du 2026-11-17). Aujourd'hui il n'a ni image, ni conteneur dans le pod, ni schema
dans `db/init`, ni migration dans `acervatim-migrate`, ni entree dans le Secret, dans
`SAGA_PARTICIPANTS` ou dans `build-images.ps1`. Ce n'est pas un oubli : en l'etat, il n'est
pas deployable. Ce qui l'empeche :

- **il n'a pas d'image de production** : seulement un `Dockerfile.dev`, celui de sa stack
  autonome (3010/3307/6380), anterieure a la constellation ;
- **il n'est pas relie au gateway** : aucune route `/v1/*` ne mene a lui, et le type de
  collection `lego` n'existe ni dans `identity` ni dans le routage par type ;
- **il est absent de la saga RGPD alors qu'il stocke des cles personnelles** : sa table
  `source_credentials` garde, par `userId`, les cles API chiffrees deposees par les
  utilisateurs. Il expose bien `DELETE /internal/users/:userId/data`, mais `SAGA_PARTICIPANTS`
  ne le cite pas : deploye tel quel, une suppression de compte laisserait ces cles derriere
  elle, et la saga se declarerait complete ;
- **il doit etre refait, pas branche** : sur `catalog-core`, comme les trois autres catalogs,
  apres une conception « collection LEGO » qui n'existe pas encore. Deployer le code actuel
  pour le remplacer ensuite couterait une reprise de donnees de plus pour un code destine a
  disparaitre.

Ce que cela implique :

- **la bascule attend ce service** : conception, reecriture sur `catalog-core`, puis entree
  dans le pod. Un premier deploiement d'essai peut se faire a dix services ; le onzieme
  s'ajoute avant la bascule ;
- d'ici la, `rebrickable-data` tourne **sans consommateur** (8.1) : sa base se constitue,
  personne ne la lit ;
- le jour ou le nouveau catalog LEGO entre dans le pod, il apporte avec lui : son image et sa
  ligne dans `build-images.ps1`, son conteneur et son schema (`db/init`, Secret,
  `migrate.sh`, `Dockerfile.migrate`), ses routes au gateway, **sa ligne dans
  `SAGA_PARTICIPANTS`**, et `REBRICKABLE_DATA_BASE_URL: http://localhost:3190` dans le ConfigMap.
