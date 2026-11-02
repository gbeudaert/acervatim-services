# Deploiement - Podman Quadlet

Deploiement de la constellation sur un hote unique, en Podman **rootless**, pilote par systemd.
Meme famille de conventions que le monolithe (`../../../acervatim-backend/deploy/`) : bases UBI
9, uid 1001, reseau Podman partage, unites dans `~/.config/containers/systemd/`.

---

## 1. Ce que ce dossier contient

| Fichier | Role |
|---|---|
| [`acervatim.kube`](acervatim.kube) | **L'unite Quadlet.** Joue le manifeste, ordonne le demarrage apres la base et Redis. |
| [`acervatim.yaml`](acervatim.yaml) | **Le manifeste.** ConfigMap + Pod : 1 initContainer de migration, 9 conteneurs applicatifs. |
| [`acervatim-secrets.example.yaml`](acervatim-secrets.example.yaml) | Gabarit du Secret. La copie remplie ne se versionne pas. |
| [`acervatim-services.network`](acervatim-services.network) | Reseau Podman de la constellation. |
| [`acervatim-db.container`](acervatim-db.container) | MariaDB - une instance, neuf schemas. |
| [`acervatim-redis.container`](acervatim-redis.container) | Redis - files BullMQ et cache premium. |
| [`Dockerfile.migrate`](Dockerfile.migrate) + [`migrate.sh`](migrate.sh) | Image unique qui joue les neuf migrations en sequence. |
| [`build-images.ps1`](build-images.ps1) | Construit les dix images. |

---

## 2. La topologie, et les deux decisions qui la determinent

```
                    systemd --user
  ┌──────────────────────┬─────────────────────┬────────────────────────┐
  │ acervatim-db.service │ acervatim-redis.svc │   acervatim.service    │
  │  (MariaDB, 9 schemas)│  (BullMQ + premium) │   podman kube play     │
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

### Un seul pod pour les neuf services

Ils partagent une pile reseau et se joignent en `localhost:31xx`. Trois consequences, toutes
voulues :

- **un seul port publie sur l'hote** (3100). Les huit autres services ne sont joignables que
  de l'interieur du pod, ce qui applique *par construction* l'invariant du 6 de
  l'architecture - « aucune route `/internal/*` n'est exposee vers l'exterieur » ;
- **pas de DNS a faire fonctionner** entre neuf conteneurs pour un deploiement mono-hote ;
- **une seule unite a redemarrer** : jamais d'etat intermediaire ou la moitie de la
  constellation tourne dans la version precedente.

Le prix : les neuf redemarrent ensemble. Acceptable tant qu'ils sont livres ensemble ; le jour
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
curl -s localhost:3100/health/ready | jq
```

`/health/ready` du gateway sonde les huit autres services : c'est le seul appel a faire pour
savoir si la constellation est complete. Il expose aussi l'ecart du registre de routage et -
via `identity` - le nombre de suppressions RGPD non terminees.

---

## 4. Migrations

Une image unique, `acervatim-migrate`, porte les neuf dossiers `prisma/` et les joue en
sequence ([`migrate.sh`](migrate.sh)). Le monolithe utilisait une cible `--target migrate` dans
son propre Dockerfile ; a neuf services, cela ferait neuf images de plus pour neuf invocations
d'un meme CLI - et surtout, cela ne garantirait plus l'**ordre**.

Elle tourne en `initContainer` : **son echec empeche le pod de demarrer**, ce qui est
infiniment preferable a neuf services tournant sur un schema a moitie migre.

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
| **total applicatif** | **≈ 1,6 Gi** | **≈ 2,6 Gi** |

Plus MariaDB et Redis, hors pod et non plafonnes ici.

**Ces chiffres sont une estimation, pas une mesure.** L'architecture est explicite : le passage
de palier doit etre justifie par une mesure (§4), et elle estimait 1 a 1,4 Go de RSS au repos
pour huit processus. La premiere chose a faire apres un demarrage reussi est de comparer :

```bash
podman stats --no-stream
```

Si le total au repos depasse nettement les `requests` cumules, ce sont les `limits` qu'il faut
revoir - pas la mesure.

Aucune limite CPU n'est declaree : la memoire est la contrainte que l'architecture pointe, et
brider le CPU de neuf processus Node ne ferait qu'allonger un demarrage deja long.

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

Le jour de la bascule, il suffit de faire pointer le reverse proxy de 3000 vers 3100 : le
contrat `/v1/*` est identique, c'est toute la contrainte du decoupage.

---

## 7. Ce qui n'a pas ete verifie

A dire clairement, parce que rien de tout cela n'a tourne :

- **Aucune image n'a ete construite.** Les Dockerfiles suivent le patron du monolithe, mais le
  build multi-stage des catalogs - qui compile `catalog-core` dans l'arborescence du service -
  n'a ete valide que par `tsc` sur l'hote, jamais dans un conteneur UBI.
- **Aucun `podman kube play` n'a ete lance.** Le manifeste est ecrit contre le comportement
  documente de Podman ; `hostPort` dans un pod, `envFrom.secretRef` et `initContainers` sont
  des fonctionnalites supportees, mais leur combinaison exacte reste a eprouver.
- **Les migrations n'ont jamais ete jouees contre MariaDB.** Elles sont ecrites a la main, pas
  generees par `prisma migrate dev`. Le premier demarrage est le vrai test - et c'est
  precisement pour cela qu'elles echouent bruyamment plutot que silencieusement.
- **`readOnlyRootFilesystem` n'est pas active**, alors qu'il est desormais a portee :
  l'ecriture d'`openapi.json` au bootstrap a ete restreinte au developpement. Ce qui reste a
  verifier est ce que Prisma ecrit dans `/tmp` a l'execution. Un `emptyDir` monte sur `/tmp`
  suffirait probablement.
