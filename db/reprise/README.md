# Reprise des donnees du monolithe

Le monolithe tient tout dans un schema (`acervatim`) ; la constellation en a dix, crees vides
par `db/init` et les migrations Prisma (dont `acv_rebrickable`, que la reprise ne concerne pas :
le monolithe n'a aucune donnee LEGO). **Sans cette reprise, basculer le reverse proxy de 3000
vers 3100 servirait des bases vides** : les utilisateurs perdraient collections, premium,
partages et liaisons aux sources externes, alors meme que l'app, elle, continuerait de marcher.

Le principe : un vidage du monolithe est charge dans un schema de transit (`acv_legacy`) de
l'instance MariaDB de la constellation, puis reparti par SQL **en une seule transaction**, et
controle table par table. Le vidage passe par un fichier plutot que par une requete directe
entre les deux bases parce que rien ne garantit qu'elles soient sur la meme instance - et le
fichier est aussi le point de retour.

| Fichier | Role |
|---|---|
| [`reprise.sh`](reprise.sh) | Les etapes, une sous-commande chacune (`reprise.sh` sans argument les liste). POSIX `sh`, Podman ou Docker. |
| [`sql/00-preconditions.sql`](sql/00-preconditions.sql) | Refus d'ecrire si le monolithe n'est pas a la version connue, si un type n'a pas de catalog ou si une table cible n'est pas vide. |
| [`sql/10-transform.sql`](sql/10-transform.sql) | La repartition. |
| [`sql/20-verify.sql`](sql/20-verify.sql) | Le controle : compte et empreinte de contenu par table, puis invariants. |
| [`sql/90-reset-targets.sql`](sql/90-reset-targets.sql) | Vide les tables cibles, entre deux repetitions. |
| [`test/jeu-complementaire.sql`](test/jeu-complementaire.sql) | Donnees de repetition couvrant les cas delicats. Jamais pour la vraie bascule. |
| [`test/parcours.js`](test/parcours.js) | Relecture des donnees reprises par les services, a travers le gateway. |

---

## 1. Ce qui est repris

| Monolithe | Destination | Transformation |
|---|---|---|
| `users`, `audit_logs` | `acv_core` | aucune |
| `subscriptions`, `premium_grants`, `invitations`, `invitation_redemptions` | `acv_billing` | aucune |
| `oauth_credentials` | `acv_conn` | aucune - jetons copies chiffres |
| `collection_shares`, `collection_share_members` | `acv_sharing` | aucune |
| `collection_share_entries` | `acv_sharing` | + `collection_name`, `type_code` de la collection |
| `collections`, `collection_nodes`, `items` | `acv_cat_manga` / `acv_cat_vinyl` / `acv_cat_generic` | par type (`CATALOG_BY_TYPE` du gateway) ; `type_id` devient `type_code` ; noeuds inseres par profondeur |
| `api_cache`, cles `edition-watch:*` | `acv_search` | aucune - c'est l'etat du rattrapage manga, pas un cache |
| *(derive)* | `acv_gateway` | registre de routage : chaque collection, chaque item, chaque noeud |

**Non repris** : `collection_types` (la migration d'identity la remplit, plus rien n'y fait
reference) et le reste d'`api_cache` (reponses d'API qui se reconstituent ; etats de liaison
OAuth de quelques minutes - un utilisateur en pleine liaison pendant la fenetre la recommence).

Les types SQL sont identiques des deux cotes, colonne par colonne (verifie le 2026-11-03 sur
`information_schema`) : la reprise copie, elle ne convertit rien.

---

## 2. Prerequis : les memes secrets

La reprise copie des donnees **derivees de secrets**. Elle n'a de sens que si la constellation
tourne avec les memes valeurs que le monolithe :

| Secret | Si la valeur change |
|---|---|
| `SUB_HASH_PEPPER` | **Perte d'acces.** La connexion Google cree un compte neuf et vide ; les donnees reprises restent orphelines. |
| `ENCRYPTION_KEY` | Les jetons OAuth repris sont illisibles : chaque utilisateur doit relier Discogs et MAL. |
| `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` | Toutes les sessions de l'app sont invalidees : reconnexion forcee. |
| `INVITE_CODE_PEPPER`, `SHARE_CODE_PEPPER` | Les codes d'invitation et de partage pas encore utilises ne fonctionnent plus. |
| `GOOGLE_CLIENT_ID` | Plus aucune connexion. |
| `DISCOGS_CONSUMER_*`, `MAL_CLIENT_*` | Les jetons repris sont lies a l'application cliente : leur renouvellement echoue. |
| `GOOGLE_PLAY_*`, `GOOGLE_PUBSUB_*` | Plus de verification d'achat ni de notification d'abonnement. |

`ADMIN_API_TOKEN`, `INTERNAL_SERVICE_TOKEN` et `INTERNAL_PRINCIPAL_SECRET` ne touchent aucune
donnee reprise.

---

## 3. Procedure de bascule

**Repetition, quelques jours avant**, sur un vidage de la production : etapes 4 a 6 ci-dessous
sur la constellation pas encore exposee, puis `CONFIRM_RESET=yes reprise.sh reset-targets` et
`reprise.sh clean`. Elle donne la duree reelle de la fenetre, et c'est elle, pas le jeu de
developpement, qui dira si les donnees de production contiennent un cas que ce script ignore.

**Le jour J** :

1. **Files du monolithe vides.** Un import de serie en cours vit dans le Redis du monolithe : il
   serait perdu. Attendre qu'aucun job ne soit actif ou en attente (`GET /v1/admin/queues` du
   monolithe).
2. **Gel des ecritures** : arreter l'API du monolithe (`systemctl --user stop acervatim-api`),
   **pas sa base**. L'app affiche des erreurs pendant la fenetre ; les notifications Google Play
   refusees sont renvoyees plus tard par Pub/Sub.
3. **Constellation demarree** avec les secrets du 2 : l'initContainer joue les migrations, les
   schemas sont prets et vides. Le proxy pointe toujours sur 3000.
4. **Reprise** :
   ```sh
   export SOURCE_CONTAINER=... SOURCE_DB_PASSWORD=... TARGET_DB_PASSWORD=... ADMIN_API_TOKEN=...
   sh db/reprise/reprise.sh dump ~/reprise-AAAAMMJJ.sql
   sh db/reprise/reprise.sh all  ~/reprise-AAAAMMJJ.sql
   sh db/reprise/reprise.sh registry
   ```
   `all` s'arrete au premier controle KO. Une erreur pendant la repartition annule tout : il
   n'y a jamais de reprise « a moitie faite » a nettoyer.
5. **Controle de disponibilite** :
   ```sh
   curl -s -o ready.json -w '%{http_code}\n' localhost:3100/health/ready   # attendu : 200
   jq -e '.status == "ok"' ready.json                                     # attendu : true
   ```
   `curl -s` seul rend 0 meme sur un `503` : c'est le code HTTP qui compte. `503` : la base du
   gateway ne repond pas. `200` mais `degraded` : un service aval n'est pas pret ou Redis manque,
   detail dans `services[]` (`reachable: true, ready: false` = processus vivant, base perdue).
   Puis une lecture a travers le gateway sur un compte connu.
6. **Decision, puis bascule du reverse proxy de 3000 vers 3100.**
7. **Apres** : `reprise.sh clean` supprime `acv_legacy`. Le fichier de vidage reste dans un
   endroit protege jusqu'a la fin de la fenetre de retour, puis il est **detruit** : il contient
   les empreintes d'identite et des jetons chiffres.

**Retour arriere.** Avant l'etape 6 : redemarrer l'API du monolithe, rien d'autre - sa base n'a
pas ete touchee. Apres l'etape 6, tant qu'aucun utilisateur n'a ecrit sur la constellation :
repointer le proxy sur 3000 et redemarrer le monolithe. **Au-dela, un retour perd les ecritures
faites depuis la bascule** : il n'existe pas de reprise en sens inverse. La decision de
l'etape 6 se prend donc sur les controles des etapes 4 et 5, pas apres.

`reset-targets` ne sert qu'entre deux essais, **jamais apres l'etape 6**.

---

## 4. Base du monolithe hors conteneur

`reprise.sh dump` passe par le conteneur MariaDB du monolithe. Si sa base est sur un autre
hote, produire le vidage la-bas avec les memes options, puis reprendre a `reprise.sh all` :

```sh
MYSQL_PWD=... mariadb-dump --user=root --single-transaction --skip-dump-date \
  --default-character-set=utf8mb4 --ignore-table=acervatim.api_cache acervatim > vidage.sql
MYSQL_PWD=... mariadb-dump --user=root --single-transaction --skip-dump-date \
  --default-character-set=utf8mb4 --where="cache_key LIKE 'edition-watch:%'" \
  acervatim api_cache >> vidage.sql
```

---

## 5. Repeter en developpement

Depuis Git Bash, a la racine de `backend-services`, la stack lancee (`./scripts/dev.ps1 up-bg`).
La base du monolithe est relue sur son volume par un MariaDB temporaire, sans port publie :
la pile du monolithe n'a pas besoin de tourner, et ses noms de conteneurs entreraient en
collision avec ceux de la constellation.

```sh
docker run -d --name acv-reprise-source -v acervatim-backend_db_data:/var/lib/mysql mariadb:10.11

export ENGINE=docker SOURCE_CONTAINER=acv-reprise-source
export SOURCE_DB_PASSWORD=$(grep '^MARIADB_ROOT_PASSWORD=' ../../acervatim-backend/.env | cut -d= -f2- | tr -d '"')
export TARGET_DB_PASSWORD=$(grep '^MARIADB_ROOT_PASSWORD=' .env | cut -d= -f2- | tr -d '"')
export ADMIN_API_TOKEN=$(grep '^ADMIN_API_TOKEN=' .env | cut -d= -f2- | tr -d '"')

sh db/reprise/reprise.sh dump /chemin/hors/depot/monolithe.sql
CONFIRM_RESET=yes sh db/reprise/reprise.sh reset-targets
sh db/reprise/reprise.sh load /chemin/hors/depot/monolithe.sql
# Facultatif - les donnees de dev du monolithe n'ont souvent ni collection ni partage :
MYSQL_PWD=$TARGET_DB_PASSWORD docker exec -i -e MYSQL_PWD acervatim-db \
  mariadb -uroot --default-character-set=utf8mb4 < db/reprise/test/jeu-complementaire.sql
sh db/reprise/reprise.sh transform
sh db/reprise/reprise.sh registry
docker compose exec -T identity node - < db/reprise/test/parcours.js   # avec le jeu seulement
sh db/reprise/reprise.sh clean
docker rm -f acv-reprise-source
```

Avec le jeu complementaire, `transform` doit finir sur `reprise conforme` et une seule ligne
`INFO` (un `item_count` volontairement faux), `registry` sur zero ecart pour 18 entrees, et
`parcours.js` sur `parcours conforme`.

---

## 6. Ce que les controles garantissent

- **Rien n'est perdu ni duplique** : compte par table, catalogs compris, source filtree par type.
- **Rien n'est altere** : empreinte de contenu par table (XOR des SHA-1 tronques de chaque
  ligne, colonnes passees par `QUOTE`). Elle detecte une milliseconde perdue, un emoji remplace,
  un texte tronque.
- **Le routage tient** : chaque collection est dans un seul catalog, le bon, et le registre y
  pointe ; le job de reconstruction du gateway, qui relit les catalogs, ne trouve aucun ecart.
- **Les copies concordent** : nom et type des entrees de partage egaux a ceux des catalogs.
- **Aucun `userId` orphelin** dans les catalogs, `billing`, `connections` et `sharing` - ce que
  les FK du monolithe garantissaient et que des schemas separes ne garantissent plus.

Ils ne garantissent pas qu'un cas present en production et absent des deux jeux de repetition
se comporte bien : c'est l'objet de la repetition sur un vidage de production (3).

---

## 7. Ce qui a ete verifie, et ce qui ne l'a pas ete

**Verifie le 2026-11-03**, en developpement (MariaDB 10.11.17, Docker) : vidage du monolithe de
dev complete du jeu complementaire, 22 tables conformes en compte et en contenu, 5 invariants,
registre sans ecart, `parcours.js` conforme. Puis les controles eux-memes : trois alterations
volontaires des cibles detectees (milliseconde, emoji, ligne de registre), seconde reprise sur
cibles pleines refusee, erreur de FK provoquee en fin de transaction suivie d'une annulation
totale (aucune ligne dans aucune cible).

**Non verifie** : le jeu sous Podman et sur l'hote de production ; la duree sur le volume reel
(la repetition du 3 la mesurera) ; un vidage produit par une version de MariaDB plus ancienne
que celle de la constellation.
