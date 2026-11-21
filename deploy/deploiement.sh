#!/bin/sh
# Deploiement de la constellation Acervatim depuis une archive construite par
# deploy/build-archive.ps1. Le script deroule les etapes une a une, note chaque etape reussie
# et reprend a la premiere qui ne l'est pas.
#
#   sh deploiement.sh <archive.tar>                  deroule les etapes 0 a 11
#   sh deploiement.sh <archive.tar> --jusqua <n>     s'arrete apres l'etape n
#   sh deploiement.sh <archive.tar> --depuis <n>     rejoue a partir de l'etape n
#   sh deploiement.sh <archive.tar> --simulation     verifications seules, rien n'est modifie
#   sh deploiement.sh statut                         etapes faites, etat des unites
#   sh deploiement.sh retour                         retour au monolithe
#   sh deploiement.sh desinstaller                   retire la constellation (avant la bascule)
#
# Les etapes 0 a 7 ne touchent pas au monolithe : elles peuvent etre jouees a l'avance
# (`--jusqua 7`). L'etape 8 gele les ecritures en arretant l'API du monolithe.
#
#    0 verifications           4 schemas sur l'instance     8 reprise des donnees (bascule)
#    1 extraction              5 unites Quadlet             9 relecture des donnees reprises
#    2 chargement des images   6 demarrage                 10 bascule du reverse proxy (manuelle)
#    3 secrets du monolithe    7 tests de fumee            11 apres la bascule
#
# Decisions de l'etude (acervatim-docs, etude-archive-deploiement-constellation.md) : schemas
# sur l'instance MariaDB du monolithe (D1), tous ses secrets repris (D2), proxy bascule a la
# main (D3), reprise en mode bascule (D5), dossier ~/acervatim-services (D6).
#
# Aucun secret n'est affiche, journalise ni passe sur une ligne de commande : ils transitent
# par des fichiers en 600, des tubes et l'environnement des clients (`-e MYSQL_PWD`).
#
# Variables : ACV_RACINE (defaut ~/acervatim-services), ACV_MONOLITHE_DIR (defaut ~/acervatim).

set -eu

RACINE=${ACV_RACINE:-"$HOME/acervatim-services"}
MONOLITHE_DIR=${ACV_MONOLITHE_DIR:-"$HOME/acervatim"}
UNITES="$HOME/.config/containers/systemd"
CONFIG="$RACINE/config"
GATEWAY_URL=http://localhost:3100
MONOLITHE_URL=http://localhost:3000
MONOLITHE_SERVICE=acervatim-api.service
MONOLITHE_CONTENEUR=acervatim-api
NOS_UNITES="acervatim-services.network acervatim-services-redis.container acervatim.kube"
DERNIERE_ETAPE=11

ARCHIVE=
VERSION=
DIR=
ETAT=
JOURNAL=/dev/null
DEPUIS=
JUSQUA=$DERNIERE_ETAPE
SIMULATION=non

# ---------------------------------------------------------------------------- affichage

dire() {
  printf '%s\n' "$*"
  printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" >>"$JOURNAL"
}

titre() {
  dire ''
  dire "=== Etape $1 : $2"
}

ok() { dire "  OK   $*"; }
attention() { dire "  ATTENTION  $*"; }
ko() { dire "  KO   $*"; }

arret() {
  dire ''
  dire "ARRET : $*"
  [ "$JOURNAL" = /dev/null ] || dire "Journal : $JOURNAL"
  exit 1
}

# Commande longue : sa sortie va au journal ; en cas d'echec, ses dernieres lignes a l'ecran.
# Jamais l'entree du script : un `podman run -i` y lirait les reponses tapees pour la suite.
executer() {
  description=$1
  shift
  printf '%s $ %s\n' "$(date '+%H:%M:%S')" "$description" >>"$JOURNAL"
  if "$@" </dev/null >>"$JOURNAL" 2>&1; then
    return 0
  fi
  dire "  echec : $description"
  tail -n 25 "$JOURNAL" | sed 's/^/    | /'
  return 1
}

# ---------------------------------------------------------------------------- saisies

# Une entree fermee n'est jamais une reponse : sans cela, une pause manuelle bouclerait.
lire() {
  IFS= read -r reponse || arret "entree standard fermee alors qu'une reponse etait attendue"
  printf '%s\n' "$reponse" >>"$JOURNAL"
}

lire_secret() {
  if [ -t 0 ]; then
    stty -echo
    trap 'stty echo' EXIT
    IFS= read -r reponse || { stty echo; arret "entree standard fermee"; }
    stty echo
    trap - EXIT
    printf '\n'
  else
    IFS= read -r reponse || arret "entree standard fermee alors qu'une reponse etait attendue"
  fi
  printf '(saisie masquee)\n' >>"$JOURNAL"
}

# suivre <fichier> <commande...> : sortie a l'ecran (indentee), dans <fichier> et au journal ;
# rend le code de la commande. Le fichier sert ensuite a chercher le verdict.
suivre() {
  sortie=$1
  shift
  statut="$sortie.statut"
  {
    if "$@" 2>&1; then echo 0 >"$statut"; else echo $? >"$statut"; fi
  } | tee "$sortie" | sed 's/^/  /'
  cat "$sortie" >>"$JOURNAL"
  r=$(cat "$statut")
  rm -f "$statut"
  return "$r"
}

# oui_non <question> : vrai si l'on tape OUI, faux si NON.
oui_non() {
  dire ''
  dire "$1"
  while :; do
    printf '  Taper OUI ou NON : '
    lire
    case "$reponse" in
      OUI) return 0 ;;
      NON) return 1 ;;
    esac
  done
}

# confirmer <question> <mot> : continue si l'on tape exactement <mot>, arrete sinon.
confirmer() {
  dire ''
  dire "$1"
  printf '  Taper %s pour continuer, autre chose pour arreter : ' "$2"
  lire
  [ "$reponse" = "$2" ] || arret "arret demande, rien n'a ete fait pour cette etape"
}

# pause_manuelle : attend FAIT (ou ARRET). Le texte de l'action est affiche avant l'appel.
pause_manuelle() {
  while :; do
    printf '  Taper FAIT quand c'"'"'est fait, ARRET pour arreter : '
    lire
    case "$reponse" in
      FAIT) return 0 ;;
      ARRET) arret "arret demande pendant l'etape manuelle" ;;
    esac
  done
}

# ---------------------------------------------------------------------------- etat

noter() {
  printf '%s %s\n' "$1" "$(date '+%Y-%m-%dT%H:%M:%S')" >>"$ETAT"
}

fait() {
  [ -f "$ETAT" ] && grep -q "^$1 " "$ETAT"
}

valeur_etat() {
  [ -f "$ETAT" ] && grep "^$1 " "$ETAT" | tail -n 1 | cut -d' ' -f2-
}

manifeste() {
  sed -n "s/^$1=//p" "$DIR/MANIFEST" | head -n 1
}

# ---------------------------------------------------------------------------- outils

# Un node sans reseau, pour composer les secrets : l'image d'identity l'a deja. `outil` ne lit
# rien ; `outil_lit` lit son entree (environnement du monolithe, valeur saisie), qui doit
# alors etre redirigee : sinon `podman run -i` mangerait les reponses tapees pour la suite.
outil_lit() {
  podman run --rm -i --network none --user 0 --cap-drop all \
    --security-opt no-new-privileges \
    -v "$DIR/deploy:/acv:ro,Z" -v "$CONFIG:/sortie:Z" \
    --entrypoint node "localhost/acervatim-identity:$VERSION" /acv/outils/secrets.js "$@"
}

outil() {
  outil_lit "$@" </dev/null
}

charger_base() {
  [ -f "$CONFIG/base.env" ] || arret "$CONFIG/base.env absent : l'etape 3 n'a pas ete faite"
  # shellcheck disable=SC1091
  . "$CONFIG/base.env"
  CLIENT_SQL=$(manifeste client_sql)
}

# Client SQL de l'instance du monolithe, avec son compte (D1, D2).
# shellcheck disable=SC2120
sql() {
  MYSQL_PWD="$ACV_DB_PASSWORD" podman run --rm -i -e MYSQL_PWD "$CLIENT_SQL" \
    mariadb --host="$ACV_DB_HOST" --port="$ACV_DB_PORT" --user="$ACV_DB_USER" \
    --default-character-set=utf8mb4 --batch --skip-column-names "$@"
}

# Environnement de reprise.sh : source et cible sont la meme instance, le meme compte.
reprise() {
  ADMIN_API_TOKEN=$(podman exec acervatim-gateway printenv ADMIN_API_TOKEN) \
    ENGINE=podman CLIENT_IMAGE="$CLIENT_SQL" \
    TARGET_DB_HOST="$ACV_DB_HOST" TARGET_DB_PORT="$ACV_DB_PORT" \
    TARGET_DB_USER="$ACV_DB_USER" TARGET_DB_PASSWORD="$ACV_DB_PASSWORD" \
    SOURCE_DB_HOST="$ACV_DB_HOST" SOURCE_DB_PORT="$ACV_DB_PORT" \
    SOURCE_DB_USER="$ACV_DB_USER" SOURCE_DB_PASSWORD="$ACV_DB_PASSWORD" \
    SOURCE_DATABASE="$ACV_DB_MONOLITHE" GATEWAY_URL="$GATEWAY_URL" \
    sh "$DIR/db/reprise/reprise.sh" "$@" </dev/null
}

code_http() {
  curl -s -o "${2:-/dev/null}" -w '%{http_code}' --max-time 10 "$1" 2>/dev/null || true
}

port_ecoute() {
  hex=$(printf '%04X' "$1")
  cat /proc/net/tcp /proc/net/tcp6 2>/dev/null |
    awk -v p=":$hex" '$2 ~ p"$" && $4 == "0A" { n++ } END { exit n > 0 ? 0 : 1 }'
}

# Les onze schemas de la constellation, lus dans db/init. Jamais autre chose que acv_* : la
# desinstallation les supprime, sur l'instance qui porte aussi la base du monolithe.
schemas() {
  sed -n 's/^CREATE DATABASE IF NOT EXISTS \(acv_[a-z_]*\) .*/\1/p' "$DIR/db/init/01-schemas.sql"
}

# ---------------------------------------------------------------------------- etape 0

etape_0() {
  titre 0 "verifications"
  echecs=0
  echec() { ko "$*"; echecs=$((echecs + 1)); }

  arch=$(manifeste architecture)
  case "$arch" in
    arm64) machine=aarch64 ;;
    amd64) machine=x86_64 ;;
    *) machine=inconnue ;;
  esac
  if [ "$(uname -m)" = "$machine" ]; then
    ok "architecture $(uname -m), celle de l'archive ($arch)"
  else
    echec "architecture $(uname -m), archive construite pour $arch"
  fi
  if [ "$(manifeste brouillon)" = oui ]; then
    attention "archive BROUILLON (arbre de travail ou commit non etiquete) : pour une repetition seulement"
  fi

  if [ "$(id -u)" -eq 0 ]; then
    echec "lance en root : le lancer avec l'utilisateur qui fait tourner le monolithe"
  else
    ok "utilisateur $(id -un), sans privileges"
  fi

  for commande in podman systemctl curl tar sha256sum awk sed df; do
    command -v "$commande" >/dev/null 2>&1 || echec "commande absente : $commande"
  done

  if command -v podman >/dev/null 2>&1; then
    pv=$(podman version --format '{{.Client.Version}}' 2>/dev/null || echo 0.0)
    majeur=${pv%%.*}
    mineur=${pv#*.}
    mineur=${mineur%%.*}
    if [ "$majeur" -gt 4 ] || { [ "$majeur" -eq 4 ] && [ "$mineur" -ge 4 ]; }; then
      ok "Podman $pv (Quadlet a partir de 4.4)"
    else
      echec "Podman $pv : Quadlet exige 4.4 ou plus"
    fi
  fi

  if systemctl --user show-environment >/dev/null 2>&1; then
    ok "systemd --user joignable"
  else
    echec "systemd --user injoignable (session sans bus utilisateur ?)"
  fi
  if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = yes ]; then
    ok "linger actif : les unites survivent a la deconnexion"
  else
    echec "linger inactif : sudo loginctl enable-linger $(id -un)"
  fi

  # Place : les images chargees, plus une marge. L'archive n'est pas extraite en entier (les
  # images sont lues directement dedans).
  requis=$(manifeste espace_requis_mio)
  for chemin in "$HOME" "$(podman info --format '{{.Store.GraphRoot}}' 2>/dev/null || echo "$HOME")"; do
    [ -d "$chemin" ] || chemin=$HOME
    libre=$(df -Pk "$chemin" | awk 'NR == 2 { print int($4 / 1024) }')
    if [ "$libre" -ge "${requis:-0}" ]; then
      ok "place libre sous $chemin : $libre Mio (requis : $requis Mio)"
    else
      echec "place libre sous $chemin : $libre Mio, requis : $requis Mio"
    fi
  done

  dispo=$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo)
  if [ "$dispo" -lt 1024 ]; then
    echec "memoire disponible : $dispo Mio (1024 au moins ; la constellation au repos en prend 500 a 600)"
  elif [ "$dispo" -lt 2048 ]; then
    attention "memoire disponible : $dispo Mio, juste pour faire tourner les deux stacks ensemble"
  else
    ok "memoire disponible : $dispo Mio"
  fi

  if port_ecoute 3100; then
    if podman container exists acervatim-gateway 2>/dev/null; then
      ok "port 3100 tenu par la constellation (reprise d'un deroule)"
    else
      echec "port 3100 deja pris par autre chose que la constellation"
    fi
  else
    ok "port 3100 libre"
  fi

  if [ "$(code_http "$MONOLITHE_URL/health")" = 200 ]; then
    ok "monolithe en service sur 3000"
  elif fait 8.gel; then
    ok "monolithe arrete (ecritures gelees a l'etape 8)"
  else
    attention "le monolithe ne repond pas sur 3000 : il doit tourner aux etapes 3 et 8"
  fi
  [ -f "$UNITES/acervatim-api.container" ] || [ -f "$RACINE/monolithe-arrete/acervatim-api.container" ] ||
    attention "unite du monolithe introuvable ($UNITES/acervatim-api.container)"

  [ "$echecs" -eq 0 ] || arret "$echecs verification(s) KO, rien n'a ete modifie"
}

# ---------------------------------------------------------------------------- etape 1

etape_1() {
  titre 1 "extraction et empreintes"
  partiel="$DIR.partiel"
  rm -rf "$partiel"
  mkdir -p "$partiel"
  # Tout sauf les images, qui restent dans l'archive : `podman load` les y lit (etape 2).
  executer "extraction" tar -xf "$ARCHIVE" -C "$partiel" --strip-components=1 \
    --exclude='*/images.tar.gz' || arret "extraction impossible"
  attendu=$(awk '$2 == "images.tar.gz" { print $1 }' "$partiel/SHA256SUMS")
  dire "  controle des empreintes (les images se relisent dans l'archive : une minute environ)"
  (cd "$partiel" && grep -v '  images.tar.gz$' SHA256SUMS | sha256sum -c --quiet -) >>"$JOURNAL" 2>&1 ||
    arret "empreintes differentes : archive alteree ou incomplete"
  calcule=$(tar -xOf "$ARCHIVE" "acervatim-services-$VERSION/images.tar.gz" | sha256sum | cut -d' ' -f1)
  [ "$calcule" = "$attendu" ] || arret "empreinte des images differente : archive alteree ou incomplete"
  rm -rf "$DIR"
  mv "$partiel" "$DIR"
  # La version est notee des maintenant : `desinstaller` doit retrouver une installation
  # interrompue, schemas compris.
  printf '%s\n' "$VERSION" >"$RACINE/version"
  ok "archive extraite dans $DIR, empreintes identiques au MANIFEST"
  if ! cmp -s "$0" "$DIR/deploiement.sh"; then
    attention "le script lance n'est pas celui de l'archive : relancer $DIR/deploiement.sh"
  fi
}

# ---------------------------------------------------------------------------- etape 2

etape_2() {
  titre 2 "chargement des images"
  dire "  podman load (plusieurs minutes)"
  tar -xOf "$ARCHIVE" "acervatim-services-$VERSION/images.tar.gz" | podman load >>"$JOURNAL" 2>&1 ||
    arret "podman load a echoue"
  arch=$(manifeste architecture)
  for image in $(manifeste images) $(manifeste redis) $(manifeste client_sql); do
    podman image exists "$image" || arret "image absente apres chargement : $image"
    a=$(podman image inspect --format '{{.Architecture}}' "$image")
    [ "$a" = "$arch" ] || arret "$image est en $a, pas en $arch"
  done
  ok "$(manifeste images | wc -w) images de la constellation et 2 images tierces, en $arch"

  # Redis : l'unite de la constellation reference le nom public. S'il est deja la (celui du
  # monolithe), on le garde ; sinon, celui de l'archive le prend.
  publique=docker.io/library/redis:7-alpine
  if podman image exists "$publique"; then
    ok "$publique deja present sur l'hote, garde tel quel"
  else
    podman tag "$(manifeste redis)" "$publique"
    ok "$publique etiquete depuis l'archive"
  fi
}

# ---------------------------------------------------------------------------- etape 3

etape_3() {
  titre 3 "secrets repris du monolithe"
  mkdir -p "$CONFIG"
  chmod 700 "$CONFIG"
  if [ -f "$CONFIG/acervatim-secrets.yaml" ]; then
    ok "secrets deja composes ($CONFIG/acervatim-secrets.yaml), conserves"
  else
    rapport="$CONFIG/.rapport"
    if podman container exists "$MONOLITHE_CONTENEUR"; then
      dire "  lecture de l'environnement du conteneur $MONOLITHE_CONTENEUR (ce qu'il voit reellement)"
      podman container inspect "$MONOLITHE_CONTENEUR" --format '{{json .Config.Env}}' |
        outil_lit composer >"$rapport" 2>>"$JOURNAL" || arret "composition des secrets impossible"
    elif [ -r "$MONOLITHE_DIR/.env" ]; then
      attention "conteneur $MONOLITHE_CONTENEUR absent : lecture de $MONOLITHE_DIR/.env, valeurs prises a la lettre"
      outil_lit composer <"$MONOLITHE_DIR/.env" >"$rapport" 2>>"$JOURNAL" ||
        arret "composition des secrets impossible"
    else
      arret "ni conteneur $MONOLITHE_CONTENEUR ni $MONOLITHE_DIR/.env : rien a reprendre"
    fi
    cat "$rapport" >>"$JOURNAL"
    grep -v '^ABSENT' "$rapport" | sed 's/^/  /'

    # Cles que le monolithe n'a pas. La cle GameUPC de production n'est que dans la
    # constellation : elle est demandee, les autres restent vides (source desactivee).
    for cle in $(sed -n 's/^ABSENT \([A-Z_]*\)$/\1/p' "$rapport"); do
      case "$cle" in
        GAMEUPC_API_KEY)
          printf '  %s (cle de production ; vide : jeux de societe inactifs) : ' "$cle"
          lire_secret
          if [ -n "$reponse" ]; then
            printf '%s' "$reponse" | outil_lit definir "$cle" || arret "ecriture de $cle impossible"
            ok "$cle saisie"
          else
            attention "$cle non saisie : laissee hors du Secret, jeux de societe inactifs"
          fi
          ;;
        *) attention "$cle absente du monolithe : laissee hors du Secret (variable non definie)" ;;
      esac
    done
    if grep -q '^ABSENTE origine publique' "$rapport"; then
      printf "  Adresse publique de l'API (ex. https://api.exemple.fr) : "
      lire
      case "$reponse" in
        http://* | https://*) ;;
        *) arret "adresse publique invalide" ;;
      esac
      printf "ACV_URL_PUBLIQUE='%s'\n" "$(printf '%s' "$reponse" | tr -d "'")" >>"$CONFIG/base.env"
    fi
    rm -f "$rapport"
  fi
  outil controler >>"$JOURNAL" 2>&1 || {
    outil controler 2>&1 | sed 's/^/  /'
    arret "cles manquantes dans $CONFIG/acervatim-secrets.yaml"
  }
  for f in acervatim-secrets.yaml base.env; do
    [ "$(stat -c %a "$CONFIG/$f")" = 600 ] || arret "$CONFIG/$f n'est pas en 600"
  done
  ok "chaque secretKeyRef du manifeste a sa cle ; fichiers en 600 dans $CONFIG"
}

# ---------------------------------------------------------------------------- etape 4

etape_4() {
  titre 4 "schemas de la constellation sur l'instance du monolithe"
  charger_base
  version_sql=$(echo "SELECT VERSION();" | sql) || arret "connexion impossible a $ACV_DB_HOST:$ACV_DB_PORT"
  compte=$(echo "SELECT CURRENT_USER();" | sql)
  ok "instance $ACV_DB_HOST:$ACV_DB_PORT, MariaDB $version_sql, compte $compte"

  # Marge de connexions de l'instance, partagee avec le monolithe. Au repos, la constellation en
  # tient une trentaine ; chaque pool Prisma peut monter a 2 x coeurs + 1, onze services.
  maximum=$(echo "SELECT @@max_connections;" | sql)
  ouvertes=$(echo "SHOW STATUS LIKE 'Threads_connected';" | sql | cut -f2)
  pire=$((11 * (2 * $(nproc 2>/dev/null || echo 4) + 1)))
  if [ $((maximum - ouvertes)) -lt "$pire" ]; then
    attention "connexions : $ouvertes ouvertes sur $maximum ; les onze pools Prisma peuvent en ouvrir $pire sous charge (une trentaine au repos)"
  else
    ok "connexions : $ouvertes ouvertes sur $maximum, marge suffisante pour les onze pools ($pire)"
  fi

  liste=$(schemas)
  [ "$(printf '%s\n' "$liste" | wc -l)" -eq 11 ] || arret "db/init/01-schemas.sql ne donne pas onze schemas"
  in_liste=$(printf "'%s'," $liste acv_legacy)
  occupes=$(echo "SELECT table_schema, COUNT(*) FROM information_schema.tables
                  WHERE table_schema IN (${in_liste%,}) GROUP BY table_schema;" | sql)
  if [ -n "$occupes" ] && fait 4; then
    # Etape rejouee (--depuis) : les tables sont celles des migrations de ce deploiement.
    ok "schemas deja crees et migres par ce deploiement, droits seulement reverifies"
  elif [ -n "$occupes" ]; then
    printf '%s\n' "$occupes" | sed 's/^/    /'
    arret "schema(s) deja occupe(s) : installation precedente ? (sh deploiement.sh desinstaller)"
  fi

  creation=
  for s in $liste; do
    creation="${creation}CREATE DATABASE IF NOT EXISTS $s CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
"
  done
  # acv_legacy, le schema de transit de la reprise, doit pouvoir etre cree puis supprime.
  essai="${creation}CREATE DATABASE IF NOT EXISTS acv_legacy; DROP DATABASE acv_legacy;"

  if printf '%s\n' "$essai" | sql >>"$JOURNAL" 2>&1; then
    ok "onze schemas crees avec le compte du monolithe"
  else
    utilisateur=${compte%@*}
    hote=${compte##*@}
    octroi="GRANT ALL PRIVILEGES ON \`acv\\_%\`.* TO '$utilisateur'@'$hote';"
    dire "  Le compte $compte ne peut pas creer les schemas acv_*. A executer par un compte"
    dire "  d'administration de l'instance (jamais GRANT ... ON *.*, celui de db/init) :"
    dire ''
    printf '%s%s\n' "$creation" "$octroi" | sed 's/^/    /'
    dire ''
    printf "  Compte d'administration (vide : je l'execute moi-meme) : "
    lire
    if [ -n "$reponse" ]; then
      admin=$reponse
      printf '  Mot de passe de %s : ' "$admin"
      lire_secret
      printf '%s%s\n' "$creation" "$octroi" |
        MYSQL_PWD="$reponse" podman run --rm -i -e MYSQL_PWD "$CLIENT_SQL" \
          mariadb --host="$ACV_DB_HOST" --port="$ACV_DB_PORT" --user="$admin" >>"$JOURNAL" 2>&1 ||
        arret "creation des schemas refusee au compte $admin"
      reponse=
    else
      pause_manuelle
    fi
    printf '%s\n' "$essai" | sql >>"$JOURNAL" 2>&1 ||
      arret "le compte $compte ne peut toujours pas creer les schemas acv_*"
    ok "onze schemas crees, droits du compte du monolithe etendus a acv_*"
  fi
}

# ---------------------------------------------------------------------------- etape 5

etape_5() {
  titre 5 "unites Quadlet et manifeste joue"
  outil assembler >>"$JOURNAL" 2>&1 || arret "assemblage du manifeste impossible"
  [ "$(stat -c %a "$CONFIG/acervatim.yaml")" = 600 ] || arret "$CONFIG/acervatim.yaml n'est pas en 600"
  mkdir -p "$UNITES" "$DIR/unites"
  # L'unite .kube pointe le manifeste joue de ce dossier de deploiement.
  for f in $NOS_UNITES; do
    sed "s|%h/acervatim-services/config/|$CONFIG/|" "$DIR/deploy/$f" >"$DIR/unites/$f"
  done
  grep -q "^Yaml=$CONFIG/acervatim.yaml$" "$DIR/unites/acervatim.kube" ||
    arret "acervatim.kube ne pointe pas $CONFIG/acervatim.yaml"
  for f in $NOS_UNITES; do
    if [ -f "$UNITES/$f" ] && ! cmp -s "$DIR/unites/$f" "$UNITES/$f"; then
      mkdir -p "$DIR/unites-precedentes"
      cp "$UNITES/$f" "$DIR/unites-precedentes/"
      attention "$f remplacee (ancienne copie dans $DIR/unites-precedentes/)"
    fi
    cp "$DIR/unites/$f" "$UNITES/$f"
  done
  executer "systemctl --user daemon-reload" systemctl --user daemon-reload || arret "daemon-reload a echoue"
  if ! systemctl --user cat acervatim.service >/dev/null 2>&1; then
    for q in /usr/libexec/podman/quadlet /usr/lib/podman/quadlet; do
      [ -x "$q" ] && "$q" -dryrun -user 2>&1 | tail -n 20 | sed 's/^/    | /'
    done
    arret "Quadlet n'a pas genere acervatim.service"
  fi
  ok "unites installees dans $UNITES, manifeste joue $CONFIG/acervatim.yaml"
}

# ---------------------------------------------------------------------------- etape 6

attendre_gateway() {
  limite=$1
  ecoule=0
  corps="$RACINE/.ready.json"
  while :; do
    c=$(code_http "$GATEWAY_URL/health/ready" "$corps")
    if [ "$c" = 200 ] && grep -q '"status":"ok"' "$corps"; then
      rm -f "$corps"
      return 0
    fi
    [ "$ecoule" -ge "$limite" ] && break
    sleep 5
    ecoule=$((ecoule + 5))
  done
  dire "  /health/ready : $c"
  [ -f "$corps" ] && sed 's/^/    | /' "$corps" | cut -c1-400 | tee -a "$JOURNAL"
  rm -f "$corps"
  return 1
}

diagnostic_pod() {
  {
    systemctl --user status acervatim.service --no-pager -l
    journalctl --user -u acervatim.service -n 60 --no-pager
    podman pod ps
    podman ps -a --pod --format '{{.Names}} {{.Status}}'
  } >>"$JOURNAL" 2>&1 || true
  podman ps -a --pod --format '    {{.Names}}  {{.Status}}' 2>/dev/null | tee -a "$JOURNAL" || true
}

etape_6() {
  titre 6 "demarrage : Redis, puis le pod (migrations en initContainer)"
  executer "start acervatim-services-redis" systemctl --user start acervatim-services-redis.service ||
    arret "Redis de la constellation ne demarre pas"
  n=0
  until [ "$(podman exec acervatim-services-redis redis-cli ping 2>/dev/null)" = PONG ]; do
    n=$((n + 1))
    [ "$n" -lt 15 ] || arret "Redis ne repond pas"
    sleep 2
  done
  ok "Redis repond"
  dire "  demarrage du pod : migrations des onze schemas, puis les services (quelques minutes)"
  if ! executer "restart acervatim" systemctl --user restart acervatim.service; then
    diagnostic_pod
    arret "le pod ne demarre pas (migrations ou services) : journalctl --user -u acervatim.service"
  fi
  ok "pod demarre, migrations jouees"
  if ! attendre_gateway 240; then
    diagnostic_pod
    arret "le gateway n'est pas pret apres 4 minutes"
  fi
  ok "gateway pret : /health/ready 200, status ok"
  podman stats --no-stream --format '{{.Name}} {{.MemUsage}}' >>"$JOURNAL" 2>&1 || true
}

# ---------------------------------------------------------------------------- etape 7

etape_7() {
  titre 7 "tests de fumee, sans donnees"
  jeton=$(podman exec acervatim-gateway printenv ADMIN_API_TOKEN) || arret "jeton admin illisible"
  sortie="$RACINE/.fumee"
  # Le jeton passe par l'environnement du seul sous-shell des tests, jamais par une ligne de
  # commande.
  if ! (
    ADMIN_API_TOKEN=$jeton
    export ADMIN_API_TOKEN GATEWAY_URL
    suivre "$sortie" sh "$DIR/deploy/tests/fumee.sh"
  ) || grep -q '^KO' "$sortie"; then
    rm -f "$sortie"
    arret "test(s) de fumee KO"
  fi
  rm -f "$sortie"
  ok "tests de fumee verts"
}

# ---------------------------------------------------------------------------- etape 8

# 0 : files vides ; 1 : jobs en attente ou actifs ; 2 : files illisibles.
files_monolithe_vides() {
  jeton=$(podman exec "$MONOLITHE_CONTENEUR" printenv ADMIN_API_TOKEN 2>/dev/null ||
    podman exec acervatim-gateway printenv ADMIN_API_TOKEN 2>/dev/null) || return 2
  corps="$RACINE/.files.json"
  c=$(printf 'header = "Authorization: Bearer %s"\n' "$jeton" |
    curl -s -o "$corps" -w '%{http_code}' --max-time 10 --config - "$MONOLITHE_URL/v1/admin/queues" || true)
  [ "$c" = 200 ] || { rm -f "$corps"; return 2; }
  # Les jobs differes (repetitions planifiees) ne comptent pas : seuls attente et actifs.
  occupes=$(grep -oE '"(waiting|active)":[0-9]+' "$corps" | awk -F: '{ s += $2 } END { print s + 0 }')
  rm -f "$corps"
  [ "$occupes" -eq 0 ]
}

empreintes_identiques() {
  monolithe="$RACINE/.empreintes-monolithe"
  constellation="$RACINE/.empreintes-constellation"
  if podman container exists "$MONOLITHE_CONTENEUR"; then
    podman container inspect "$MONOLITHE_CONTENEUR" --format '{{json .Config.Env}}' |
      outil_lit empreintes-entree >"$monolithe"
  else
    cp "$CONFIG/empreintes-monolithe" "$monolithe"
  fi
  podman exec -i acervatim-identity node - empreintes <"$DIR/deploy/outils/secrets.js" >"$constellation"
  if cmp -s "$monolithe" "$constellation"; then
    rm -f "$monolithe" "$constellation"
    return 0
  fi
  dire "  secrets critiques differents entre le monolithe et la constellation :"
  paste -d' ' "$monolithe" "$constellation" | awk '$2 != $4 { print "    " $1 }' | tee -a "$JOURNAL"
  rm -f "$monolithe" "$constellation"
  return 1
}

etape_8() {
  titre 8 "reprise des donnees, ecritures gelees"
  charger_base
  mkdir -p "$RACINE/reprise"
  chmod 700 "$RACINE/reprise"

  if ! fait 8.gel; then
    empreintes_identiques || arret "secrets differents : la reprise rendrait les donnees inaccessibles"
    ok "secrets critiques identiques a ceux du monolithe (empreintes)"
    systemctl --user is-active --quiet "$MONOLITHE_SERVICE" ||
      arret "$MONOLITHE_SERVICE n'est pas actif : rien a geler"
    n=0
    while :; do
      r=0
      files_monolithe_vides || r=$?
      if [ "$r" -eq 0 ]; then
        ok "files du monolithe vides (aucun job en attente ni actif)"
        break
      fi
      if [ "$r" -eq 2 ]; then
        attention "files du monolithe illisibles (GET /v1/admin/queues) : a verifier soi-meme"
        confirmer "Les files du monolithe sont-elles vides ?" VIDES
        break
      fi
      n=$((n + 1))
      [ "$n" -le 18 ] || arret "files du monolithe toujours occupees apres 3 minutes"
      dire "  jobs en cours dans le monolithe, nouvel essai dans 10 s"
      sleep 10
    done
    confirmer "Gel des ecritures : arret de $MONOLITHE_SERVICE (sa base reste). L'app affichera des erreurs jusqu'a l'etape 10." GELER
    executer "stop $MONOLITHE_SERVICE" systemctl --user stop "$MONOLITHE_SERVICE" || arret "arret du monolithe impossible"
    [ "$(code_http "$MONOLITHE_URL/health")" != 200 ] || arret "le monolithe repond encore sur 3000"
    noter 8.gel
    ok "monolithe arrete, ecritures gelees (retour : sh deploiement.sh retour)"
  fi

  if ! fait 8.vidage; then
    vidage="$RACINE/reprise/vidage-$(date '+%Y%m%d-%H%M%S').sql"
    executer "reprise.sh dump" reprise dump "$vidage" || arret "vidage du monolithe impossible"
    noter "8.vidage $vidage"
    ok "vidage : $vidage ($(wc -c <"$vidage" | tr -d ' ') octets)"
  fi
  vidage=$(valeur_etat 8.vidage | cut -d' ' -f1)

  sortie="$RACINE/reprise/.sortie"
  if ! fait 8.repartition; then
    dire "  chargement, preconditions, repartition en une transaction, controle"
    if ! suivre "$sortie" reprise all "$vidage" || ! grep -q '^reprise: reprise conforme' "$sortie"; then
      rm -f "$sortie"
      arret "reprise non conforme (une repartition echouee est annulee en entier) ; retour : sh deploiement.sh retour"
    fi
    noter 8.repartition
    ok "reprise conforme, table par table"
  fi

  if ! fait 8.registre; then
    if ! suivre "$sortie" reprise registry || ! grep -q '^reprise: registre conforme' "$sortie"; then
      rm -f "$sortie"
      arret "registre de routage divergent"
    fi
    noter 8.registre
    ok "registre de routage sans ecart"
  fi
  rm -f "$sortie"
}

# ---------------------------------------------------------------------------- etape 9

etape_9() {
  titre 9 "relecture des donnees reprises, a travers le gateway"
  charger_base
  attendu="$RACINE/reprise/attendu.tsv"
  (umask 077 && sql >"$attendu" <<'SQL'
SELECT 'U', u.id, '', '' FROM acv_legacy.users u
UNION ALL
SELECT 'C', c.user_id, c.id, (SELECT COUNT(*) FROM acv_legacy.items i WHERE i.collection_id = c.id)
FROM acv_legacy.collections c;
SQL
  ) || arret "lecture des donnees attendues impossible (acv_legacy supprime ?)"
  dire "  $(grep -c '^U' "$attendu" || true) utilisateurs, $(grep -c '^C' "$attendu" || true) collections a relire"
  sortie="$RACINE/reprise/.relecture"
  if ! suivre "$sortie" podman exec -i -e RELECTURE_GATEWAY_URL="$GATEWAY_URL" acervatim-identity \
    node -e "$(cat "$DIR/deploy/tests/relecture.js")" <"$attendu" ||
    ! grep -q '^relecture conforme' "$sortie"; then
    rm -f "$sortie" "$attendu"
    arret "relecture KO : les services ne relisent pas ce que la reprise a ecrit"
  fi
  rm -f "$sortie" "$attendu"
  ok "chaque utilisateur retrouve ses collections et leurs items"
}

# ---------------------------------------------------------------------------- etape 10

etape_10() {
  titre 10 "bascule du reverse proxy (manuelle)"
  charger_base
  publique=${ACV_URL_PUBLIQUE:-}
  if [ -z "$publique" ]; then
    printf "  Adresse publique de l'API : "
    lire
    publique=$reponse
  fi
  dire ''
  dire "  A FAIRE dans la configuration du reverse proxy qui sert $publique :"
  dire "    1. remplacer la cible http://localhost:3000 par http://localhost:3100 ;"
  dire "    2. ne pas relayer les chemins /internal/ (routes entre services et d'exploitation) ;"
  dire "    3. recharger le proxy."
  dire "  Le contrat /v1/* est identique : rien d'autre ne change cote app."
  dire "  Retour tant qu'aucun utilisateur n'a ecrit : repointer sur 3000, puis sh deploiement.sh retour."
  dire ''
  while :; do
    pause_manuelle
    corps="$RACINE/.public.json"
    c=$(curl -s -o "$corps" -w '%{http_code}' --max-time 15 "$publique/health/ready" 2>/dev/null || true)
    if [ "$c" = 200 ] && grep -q '"services"' "$corps"; then
      rm -f "$corps"
      break
    fi
    rm -f "$corps"
    attention "$publique/health/ready repond $c, pas encore par la constellation"
  done
  noter 10.bascule
  debut=$(valeur_etat 8.gel)
  ok "la constellation repond par $publique (ecritures gelees depuis $debut)"
}

# ---------------------------------------------------------------------------- etape 11

etape_11() {
  titre 11 "apres la bascule"
  charger_base
  executer "reprise.sh clean" reprise clean || attention "acv_legacy non supprime : sh $DIR/db/reprise/reprise.sh clean"
  ok "schema de transit acv_legacy supprime"
  if [ -f "$UNITES/acervatim-api.container" ]; then
    if oui_non "Empecher le monolithe de redemarrer au prochain demarrage de l'hote ? Son image, son .env et sa base restent, pour le retour."; then
      mkdir -p "$RACINE/monolithe-arrete"
      mv "$UNITES/acervatim-api.container" "$RACINE/monolithe-arrete/"
      executer "daemon-reload" systemctl --user daemon-reload || true
      ok "unite du monolithe mise de cote dans $RACINE/monolithe-arrete/"
    else
      attention "le monolithe redemarrera avec l'hote, sur sa base figee : a arreter a la main"
    fi
  fi
  vidage=$(valeur_etat 8.vidage | cut -d' ' -f1)
  dire ''
  dire "  Le vidage $vidage contient les empreintes d'identite et des jetons chiffres :"
  dire "  le garder jusqu'a la fin de la fenetre de retour, puis le detruire (rm)."
  dire "  Le Redis du monolithe (acervatim-redis) tourne encore ; il ne sert plus."
}

# ---------------------------------------------------------------------------- sous-commandes

version_installee() {
  [ -f "$RACINE/version" ] || arret "aucune version installee dans $RACINE"
  VERSION=$(cat "$RACINE/version")
  DIR="$RACINE/$VERSION"
  ETAT="$RACINE/etat-$VERSION"
  mkdir -p "$RACINE/journal"
  JOURNAL="$RACINE/journal/$(date '+%Y%m%d-%H%M%S')-$1.log"
}

cmd_statut() {
  version_installee statut
  dire "Version $VERSION, dossier $DIR"
  dire "Etapes faites (derniere fois) :"
  # Une etape rejouee (--depuis) apparait plusieurs fois dans le fichier d'etat : sa derniere
  # ligne fait foi, a la place de sa premiere apparition.
  [ -f "$ETAT" ] && awk '!($1 in rang) { rang[$1] = ++n; cle[n] = $1 } { ligne[$1] = $0 }
    END { for (i = 1; i <= n; i++) print "  " ligne[cle[i]] }' "$ETAT" | tee -a "$JOURNAL"
  for u in acervatim-services-redis.service acervatim.service "$MONOLITHE_SERVICE"; do
    dire "  $u : $(systemctl --user is-active "$u" 2>/dev/null || true)"
  done
  dire "  gateway /health/ready : $(code_http "$GATEWAY_URL/health/ready")"
  dire "  monolithe /health : $(code_http "$MONOLITHE_URL/health")"
}

cmd_retour() {
  version_installee retour
  if fait 10.bascule; then
    dire "Le proxy pointe sur la constellation. Un retour perd toute ecriture faite depuis la bascule"
    dire "($(valeur_etat 10.bascule)) : il n'existe pas de reprise en sens inverse."
    confirmer "Revenir au monolithe malgre tout ?" RETOUR
    dire "  A FAIRE : repointer le reverse proxy sur http://localhost:3000 et le recharger."
    pause_manuelle
  else
    confirmer "Retour au monolithe : la constellation s'arrete, le monolithe redemarre sur sa base intacte." RETOUR
  fi
  if [ -f "$RACINE/monolithe-arrete/acervatim-api.container" ]; then
    mv "$RACINE/monolithe-arrete/acervatim-api.container" "$UNITES/"
    executer "daemon-reload" systemctl --user daemon-reload || true
  fi
  executer "stop acervatim" systemctl --user stop acervatim.service || true
  executer "start $MONOLITHE_SERVICE" systemctl --user start "$MONOLITHE_SERVICE" ||
    arret "le monolithe ne redemarre pas : systemctl --user status $MONOLITHE_SERVICE"
  n=0
  until [ "$(code_http "$MONOLITHE_URL/health")" = 200 ]; do
    n=$((n + 1))
    [ "$n" -lt 30 ] || arret "le monolithe ne repond pas sur 3000"
    sleep 2
  done
  noter retour
  ok "monolithe en service sur 3000, constellation arretee (ses schemas restent)"
  if fait 10.bascule && [ -f "$CONFIG/base.env" ]; then
    charger_base
    corps="$RACINE/.public.json"
    c=$(curl -s -o "$corps" -w '%{http_code}' --max-time 15 "${ACV_URL_PUBLIQUE:-}/health" 2>/dev/null || true)
    if [ "$c" = 200 ] && ! grep -q 'acervatim-gateway' "$corps"; then
      ok "l'URL publique ${ACV_URL_PUBLIQUE:-} repond par le monolithe"
    else
      attention "l'URL publique ${ACV_URL_PUBLIQUE:-} ne repond pas par le monolithe ($c) : verifier le proxy"
    fi
    rm -f "$corps"
  fi
  dire "  Nouvelle tentative : sh deploiement.sh desinstaller, puis relancer le deroule."
}

cmd_desinstaller() {
  version_installee desinstaller
  if fait 10.bascule && ! fait retour; then
    arret "la constellation sert les utilisateurs depuis la bascule : desinstaller perdrait leurs donnees"
  fi
  confirmer "Retirer la constellation $VERSION : pod, unites, Redis et son volume, images, et les schemas acv_* de l'instance (leurs donnees comprises). Le monolithe, son dossier et sa base ne sont pas touches." SUPPRIMER
  systemctl --user stop acervatim.service acervatim-services-redis.service >>"$JOURNAL" 2>&1 || true
  for f in $NOS_UNITES; do rm -f "$UNITES/$f"; done
  systemctl --user daemon-reload >>"$JOURNAL" 2>&1 || true
  podman pod rm -f acervatim >>"$JOURNAL" 2>&1 || true
  podman volume rm acervatim-services-redis-data >>"$JOURNAL" 2>&1 || true
  ok "pod, unites et Redis retires"
  if [ -f "$CONFIG/base.env" ] && [ -f "$DIR/MANIFEST" ]; then
    charger_base
    suppression=
    for s in $(schemas) acv_legacy; do suppression="${suppression}DROP DATABASE IF EXISTS $s; "; done
    if printf '%s\n' "$suppression" | sql >>"$JOURNAL" 2>&1; then
      ok "schemas acv_* supprimes de l'instance"
    else
      attention "schemas acv_* non supprimes (droits ?) : a faire a la main"
    fi
  fi
  if [ -f "$DIR/MANIFEST" ]; then
    for image in $(manifeste images) $(manifeste client_sql) $(manifeste redis); do
      podman rmi "$image" >>"$JOURNAL" 2>&1 || true
    done
    ok "images de la constellation retirees"
  fi
  rm -rf "$CONFIG" "$DIR" "$ETAT" "$RACINE/version"
  ok "configuration et dossier de version supprimes"
  if [ -d "$RACINE/reprise" ] && [ -n "$(ls -A "$RACINE/reprise" 2>/dev/null)" ]; then
    attention "vidages du monolithe encore presents dans $RACINE/reprise : a detruire"
  fi
}

# ---------------------------------------------------------------------------- deroule

usage() {
  sed -n '6,13p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

deroule() {
  ARCHIVE=$1
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --depuis) DEPUIS=${2:?}; shift 2 ;;
      --jusqua) JUSQUA=${2:?}; shift 2 ;;
      --simulation) SIMULATION=oui; shift ;;
      *) usage ;;
    esac
  done
  [ -f "$ARCHIVE" ] || arret "archive introuvable : $ARCHIVE"
  ARCHIVE=$(cd "$(dirname "$ARCHIVE")" && pwd)/$(basename "$ARCHIVE")
  premier=$(tar -tf "$ARCHIVE" 2>/dev/null | head -n 1 || true)
  VERSION=${premier%%/*}
  VERSION=${VERSION#acervatim-services-}
  [ -n "$VERSION" ] && [ "$VERSION" != "$premier" ] || arret "archive illisible : $ARCHIVE"

  mkdir -p "$RACINE/journal"
  chmod 700 "$RACINE"
  DIR="$RACINE/$VERSION"
  ETAT="$RACINE/etat-$VERSION"
  JOURNAL="$RACINE/journal/$(date '+%Y%m%d-%H%M%S')-$VERSION.log"
  : >"$JOURNAL"

  if [ -f "$RACINE/version" ] && [ "$(cat "$RACINE/version")" != "$VERSION" ]; then
    arret "la version $(cat "$RACINE/version") est installee : la mise a jour n'est pas encore prise en charge"
  fi

  # Le MANIFEST se lit dans l'archive tant qu'elle n'est pas extraite.
  if [ ! -f "$DIR/MANIFEST" ]; then
    lecture="$RACINE/.manifeste-$VERSION"
    mkdir -p "$lecture"
    tar -xf "$ARCHIVE" -C "$lecture" --strip-components=1 "acervatim-services-$VERSION/MANIFEST" ||
      arret "MANIFEST absent de l'archive"
    DIR_LECTURE=$DIR
    DIR=$lecture
  fi

  dire "Constellation Acervatim $VERSION ($(manifeste architecture), commit $(manifeste commit))"
  dire "Archive : $ARCHIVE"
  dire "Journal : $JOURNAL"
  etape_0
  if [ -n "${DIR_LECTURE:-}" ]; then
    rm -rf "$DIR"
    DIR=$DIR_LECTURE
  fi

  if [ "$SIMULATION" = oui ]; then
    dire ''
    dire "Simulation : rien n'a ete modifie. Etapes qui seraient jouees :"
    for ETAPE in 1 2 3 4 5 6 7 8 9 10 11; do
      if fait "$ETAPE"; then dire "  $ETAPE deja faite"; elif [ "$ETAPE" -le "$JUSQUA" ]; then dire "  $ETAPE a jouer"; fi
    done
    exit 0
  fi

  # ETAPE, en majuscules, est reservee au deroule : les etapes ont leurs propres compteurs, et
  # une variable sh est globale.
  ETAPE=1
  while [ "$ETAPE" -le "$JUSQUA" ]; do
    if [ -n "$DEPUIS" ] && [ "$ETAPE" -lt "$DEPUIS" ]; then
      :
    elif fait "$ETAPE" && { [ -z "$DEPUIS" ] || [ "$ETAPE" -lt "$DEPUIS" ]; }; then
      dire "Etape $ETAPE : deja faite le $(valeur_etat "$ETAPE")"
    else
      "etape_$ETAPE"
      noter "$ETAPE"
    fi
    ETAPE=$((ETAPE + 1))
  done
  dire ''
  if [ "$JUSQUA" -lt "$DERNIERE_ETAPE" ]; then
    dire "Arret demande apres l'etape $JUSQUA. Relancer sans --jusqua pour continuer."
  else
    dire "Deploiement termine. Etat : sh $0 statut"
  fi
  dire "Journal : $JOURNAL"
}

case "${1:-}" in
  statut) cmd_statut ;;
  retour) cmd_retour ;;
  desinstaller) cmd_desinstaller ;;
  '' | -h | --help) usage ;;
  *) deroule "$@" ;;
esac
