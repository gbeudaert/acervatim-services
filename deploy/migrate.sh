#!/bin/sh
# Joue `prisma migrate deploy` sur les onze schemas de la constellation, en sequence.
#
# Chaque service a SON `DATABASE_URL`, pointant SON schema logique sur l'instance MariaDB
# partagee (decision du 7 de architecture-microservices.md). Ce script ne fait donc que
# boucler : il ne compose aucune URL, il consomme celles que le pod lui passe, ce qui evite
# qu'un secret de connexion soit reconstruit a deux endroits differents.
#
# `set -e` : la premiere migration qui echoue arrete tout. C'est voulu - en initContainer,
# un echec empeche le pod de demarrer, ce qui est infiniment preferable a onze services qui
# tournent sur un schema a moitie migre.

set -eu

# `rebrickable-data` (schema `acv_rebrickable`) puis `catalog-lego` (schema `acv_cat_lego`,
# variable DATABASE_URL_CATALOG_LEGO) ferment la liste.
SERVICES="gateway identity billing connections sharing search catalog-generic catalog-manga catalog-vinyl rebrickable-data catalog-lego"

# Attente de la base. L'initContainer demarre des que le pod est ordonnance ; MariaDB tourne
# dans un conteneur voisin (unite systemd distincte), demarre avant par `After=` - mais
# « demarre » n'est pas « prete a accepter des connexions ». Sans cette attente, la premiere
# migration echoue sur un refus de connexion et fait echouer tout le pod, pour une raison
# purement transitoire.
: "${DB_WAIT_SECONDS:=60}"
: "${DB_HOST:=acervatim-db}"
: "${DB_PORT:=3306}"

echo "migrate: attente de ${DB_HOST}:${DB_PORT} (max ${DB_WAIT_SECONDS}s)"
waited=0
while ! node -e "
  const net = require('net');
  const s = net.connect({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT) });
  s.on('connect', () => { s.end(); process.exit(0); });
  s.on('error', () => process.exit(1));
  s.setTimeout(2000, () => { s.destroy(); process.exit(1); });
" 2>/dev/null; do
  waited=$((waited + 2))
  if [ "$waited" -ge "$DB_WAIT_SECONDS" ]; then
    echo "migrate: ${DB_HOST}:${DB_PORT} injoignable apres ${DB_WAIT_SECONDS}s" >&2
    exit 1
  fi
  sleep 2
done
echo "migrate: base joignable"

for svc in $SERVICES; do
  # Nom de la variable attendue : DATABASE_URL_GATEWAY, DATABASE_URL_CATALOG_MANGA, ...
  var="DATABASE_URL_$(echo "$svc" | tr 'a-z-' 'A-Z_')"
  url=$(eval "printf '%s' \"\${$var:-}\"")

  if [ -z "$url" ]; then
    echo "migrate: $var absent - $svc ignore" >&2
    # Pas d'echec : la constellation doit pouvoir se deployer partiellement (un service
    # retire de la configuration ne doit pas bloquer les dix autres). Un service dont les
    # migrations n'ont pas tourne echouera de lui-meme, bruyamment, au premier acces.
    continue
  fi

  echo "migrate: $svc"
  DATABASE_URL="$url" npx prisma migrate deploy --schema "./schemas/$svc/schema.prisma"
done

echo "migrate: termine"
