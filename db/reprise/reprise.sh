#!/bin/sh
# Reprise des donnees du monolithe dans les schemas de la constellation.
#
# Le monolithe tient tout dans un schema (`acervatim`), la constellation en a neuf. Ce script
# charge un vidage du monolithe dans un schema de transit (`acv_legacy`) de l'instance MariaDB
# de la constellation, le repartit par SQL en une seule transaction, puis compare source et
# cible table par table. La procedure de bascule complete est dans README.md.
#
# Les etapes sont separees pour pouvoir etre rejouees une a une le jour de la bascule ;
# `all` enchaine load, transform et verify.
#
#   reprise.sh dump <fichier>     vidage de la base du monolithe (conteneur SOURCE_CONTAINER)
#   reprise.sh load <fichier>     chargement du vidage dans acv_legacy (recree a chaque fois)
#   reprise.sh check              preconditions seules
#   reprise.sh transform          preconditions, repartition, controle
#   reprise.sh verify             controle seul
#   reprise.sh registry           reconstruction du registre par le gateway : zero ecart attendu
#   reprise.sh all <fichier>      load + transform
#   reprise.sh clean              suppression d'acv_legacy
#   reprise.sh reset-targets      vide les tables cibles (CONFIRM_RESET=yes) - jamais apres bascule
#
# Variables :
#   ENGINE                 docker | podman (defaut : podman s'il est installe, sinon docker)
#   TARGET_CONTAINER       MariaDB de la constellation (defaut : acervatim-db)
#   TARGET_DB_USER         defaut : root - la reprise ecrit dans tous les schemas
#   TARGET_DB_PASSWORD     obligatoire, sauf pour dump
#   SOURCE_CONTAINER       MariaDB du monolithe, pour dump seulement
#   SOURCE_DATABASE        defaut : acervatim
#   SOURCE_DB_USER         defaut : root
#   SOURCE_DB_PASSWORD     obligatoire pour dump
#   GATEWAY_URL            defaut : http://localhost:3100, pour registry
#   ADMIN_API_TOKEN        obligatoire pour registry (la route est sous AdminGuard)
#
# Aucun mot de passe ni jeton ne passe sur une ligne de commande : ils seraient lisibles dans
# la liste des processus de l'hote. Les mots de passe vont au client par `-e MYSQL_PWD` (sans
# valeur, le moteur recopie la variable depuis l'environnement du script), le jeton a curl
# par sa configuration lue sur l'entree standard.

set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
SQL_DIR="$HERE/sql"

: "${ENGINE:=}"
: "${TARGET_CONTAINER:=acervatim-db}"
: "${TARGET_DB_USER:=root}"
: "${SOURCE_CONTAINER:=}"
: "${SOURCE_DATABASE:=acervatim}"
: "${SOURCE_DB_USER:=root}"
: "${GATEWAY_URL:=http://localhost:3100}"

die() {
  echo "reprise: $*" >&2
  exit 1
}

log() {
  echo "reprise: $*"
}

if [ -z "$ENGINE" ]; then
  if command -v podman >/dev/null 2>&1; then ENGINE=podman; else ENGINE=docker; fi
fi

# Client SQL dans le conteneur cible. Arguments supplementaires passes a `mariadb`.
target_sql() {
  [ -n "${TARGET_DB_PASSWORD:-}" ] || die "TARGET_DB_PASSWORD absent"
  MYSQL_PWD="$TARGET_DB_PASSWORD" "$ENGINE" exec -i -e MYSQL_PWD "$TARGET_CONTAINER" \
    mariadb --user="$TARGET_DB_USER" --default-character-set=utf8mb4 "$@"
}

# Joue un fichier de rapport (00-preconditions.sql, 20-verify.sql) : chaque ligne est
# etape, objet, source, cible, statut. Echoue si un statut commence par KO.
report() {
  file=$1
  out=$(target_sql --batch --skip-column-names < "$file") || die "echec SQL dans $(basename "$file")"
  printf '%s\n' "$out" | awk -F '\t' '{ printf "  %-13s %-52s %10s %10s  %s\n", $1, $2, $3, $4, $5 }'
  ko=$(printf '%s\n' "$out" | awk -F '\t' '$5 ~ /^KO/ { n++ } END { print n + 0 }')
  [ "$ko" -eq 0 ] || die "$ko controle(s) KO dans $(basename "$file")"
}

cmd_dump() {
  out=${1:-}
  [ -n "$out" ] || die "usage : reprise.sh dump <fichier>"
  [ -n "$SOURCE_CONTAINER" ] || die "SOURCE_CONTAINER absent (base du monolithe hors conteneur : README.md, 4)"
  [ -n "${SOURCE_DB_PASSWORD:-}" ] || die "SOURCE_DB_PASSWORD absent"
  [ ! -e "$out" ] || die "$out existe deja : un vidage n'est jamais ecrase"

  # Le vidage porte des jetons OAuth chiffres et les empreintes d'identite : lisible du seul
  # proprietaire, et ecrit sous un nom provisoire pour qu'un vidage interrompu ne puisse pas
  # etre pris pour un vidage complet.
  umask 077
  partial="$out.partiel"
  rm -f "$partial"

  # Deux passes : tout sauf `api_cache`, puis `api_cache` restreint a l'etat du rattrapage
  # manga, seule famille de cle reprise (sql/10-transform.sql). Le reste du cache n'a rien a
  # faire dans un fichier qui va circuler. Deux instantanes distincts, ce qui ne pose pas de
  # probleme : les ecritures sont gelees avant le vidage (README.md, 3).
  MYSQL_PWD="$SOURCE_DB_PASSWORD" "$ENGINE" exec -e MYSQL_PWD "$SOURCE_CONTAINER" \
    mariadb-dump --user="$SOURCE_DB_USER" --single-transaction --skip-dump-date \
    --default-character-set=utf8mb4 --ignore-table="$SOURCE_DATABASE.api_cache" \
    "$SOURCE_DATABASE" > "$partial" || { rm -f "$partial"; die "vidage echoue"; }
  MYSQL_PWD="$SOURCE_DB_PASSWORD" "$ENGINE" exec -e MYSQL_PWD "$SOURCE_CONTAINER" \
    mariadb-dump --user="$SOURCE_DB_USER" --single-transaction --skip-dump-date \
    --default-character-set=utf8mb4 --where="cache_key LIKE 'edition-watch:%'" \
    "$SOURCE_DATABASE" api_cache >> "$partial" || { rm -f "$partial"; die "vidage du cache echoue"; }

  mv "$partial" "$out"
  log "vidage ecrit : $out ($(wc -c < "$out" | tr -d ' ') octets)"
}

cmd_load() {
  in=${1:-}
  [ -f "$in" ] || die "usage : reprise.sh load <fichier> (fichier introuvable : $in)"
  # Schema de transit recree a chaque chargement : un reste d'essai precedent ne doit jamais
  # se meler au vidage du jour.
  target_sql -e "DROP DATABASE IF EXISTS acv_legacy;
                 CREATE DATABASE acv_legacy CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
  target_sql acv_legacy < "$in" || die "chargement echoue"
  log "vidage charge dans acv_legacy"
}

cmd_check() {
  log "preconditions"
  report "$SQL_DIR/00-preconditions.sql"
}

cmd_verify() {
  log "controle source / cible"
  report "$SQL_DIR/20-verify.sql"
  log "reprise conforme"
}

cmd_transform() {
  cmd_check
  log "repartition (une transaction)"
  target_sql < "$SQL_DIR/10-transform.sql" || die "repartition annulee, aucune ligne ecrite"
  cmd_verify
}

cmd_registry() {
  [ -n "${ADMIN_API_TOKEN:-}" ] || die "ADMIN_API_TOKEN absent"
  log "reconstruction du registre par le gateway"
  body=$(printf 'header = "Authorization: Bearer %s"\n' "$ADMIN_API_TOKEN" |
    curl --silent --show-error --fail --max-time 120 --config - \
      -X POST "$GATEWAY_URL/internal/registry/rebuild") || die "appel au gateway echoue"
  echo "  $body"
  # Le job relit chaque catalog et corrige le registre : apres une reprise juste, il n'a rien
  # a corriger. Un catalog injoignable (`skipped`) rend le controle sans valeur.
  for field in added removed corrected; do
    printf '%s' "$body" | grep -q "\"$field\":0[,}]" || die "registre divergent ($field non nul)"
  done
  printf '%s' "$body" | grep -q '"skipped":\[\]' || die "catalog(s) non scanne(s) : controle sans valeur"
  log "registre conforme"
}

cmd_clean() {
  target_sql -e "DROP DATABASE IF EXISTS acv_legacy;"
  log "acv_legacy supprime"
}

cmd_reset_targets() {
  [ "${CONFIRM_RESET:-}" = "yes" ] ||
    die "reset-targets vide les tables cibles : relancer avec CONFIRM_RESET=yes, et jamais apres la bascule"
  target_sql < "$SQL_DIR/90-reset-targets.sql" || die "vidage des cibles echoue"
  log "tables cibles videes"
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case "$cmd" in
  dump) cmd_dump "$@" ;;
  load) cmd_load "$@" ;;
  check) cmd_check ;;
  transform) cmd_transform ;;
  verify) cmd_verify ;;
  registry) cmd_registry ;;
  all)
    cmd_load "$@"
    cmd_transform
    ;;
  clean) cmd_clean ;;
  reset-targets) cmd_reset_targets ;;
  *)
    sed -n '12,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
