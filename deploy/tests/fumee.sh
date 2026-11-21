#!/bin/sh
# Tests de fumee de la constellation deployee, sans donnees : l'etape 7 de deploiement.sh.
# Ils ne lisent ni n'ecrivent aucune donnee d'utilisateur.
#
#   ADMIN_API_TOKEN=... sh deploy/tests/fumee.sh
#
# Variables : ADMIN_API_TOKEN (obligatoire), GATEWAY_URL (defaut http://localhost:3100),
# POD (defaut acervatim). Une ligne par controle, `OK` ou `KO` en tete ; code de sortie 1 si
# l'un d'eux est KO. Seuls curl et podman sont requis.

set -u

: "${GATEWAY_URL:=http://localhost:3100}"
: "${POD:=acervatim}"
[ -n "${ADMIN_API_TOKEN:-}" ] || { echo "fumee: ADMIN_API_TOKEN absent" >&2; exit 2; }

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
echecs=0

verdict() {
  if [ "$1" = oui ]; then
    echo "OK  $2"
  else
    echo "KO  $2${3:+  -> $3}"
    echecs=$((echecs + 1))
  fi
}

# get <chemin> [jeton] : ecrit le corps dans $TMP, rend le code HTTP. Le jeton passe a curl par
# sa configuration lue sur l'entree standard, jamais sur la ligne de commande.
get() {
  if [ -n "${2:-}" ]; then
    printf 'header = "Authorization: Bearer %s"\n' "$2" |
      curl -s -o "$TMP" -w '%{http_code}' --max-time 20 --config - "$GATEWAY_URL$1" || true
  else
    curl -s -o "$TMP" -w '%{http_code}' --max-time 20 "$GATEWAY_URL$1" || true
  fi
}

attendre() {
  c=$1
  attendu=$2
  if [ "$c" = "$attendu" ]; then echo oui; else echo non; fi
}

c=$(get /health)
verdict "$(attendre "$c" 200)" "gateway /health : 200" "$c"

c=$(get /health/ready)
if [ "$c" = 200 ] && grep -q '"status":"ok"' "$TMP"; then r=oui; else r=non; fi
verdict "$r" "gateway /health/ready : 200, status ok" "$c $(head -c 300 "$TMP")"

c=$(get /v1/me)
verdict "$(attendre "$c" 401)" "route protegee sans jeton : 401" "$c"

c=$(get /v1/collections jeton-invalide)
verdict "$(attendre "$c" 401)" "jeton invalide : 401" "$c"

c=$(get /v1/admin/queues)
verdict "$(attendre "$c" 401)" "route admin sans jeton : 401" "$c"

c=$(get /v1/admin/queues "$ADMIN_API_TOKEN")
if [ "$c" = 200 ] && grep -q '"queues"' "$TMP"; then r=oui; else r=non; fi
verdict "$r" "route admin avec le jeton d'exploitation : 200 (files de search)" "$c"

c=$(get /openapi.json)
if [ "$c" = 200 ] && grep -q '"openapi"' "$TMP"; then r=oui; else r=non; fi
verdict "$r" "specification OpenAPI agregee : 200" "$c"

# Les dix services derriere le gateway, de l'interieur du pod (leurs ports ne sont pas
# publies) : la sonde de disponibilite de chacun, base comprise.
sondes=$(podman exec "$POD-gateway" node -e '
  const services = { identity: 3110, billing: 3120, connections: 3130, sharing: 3140,
    search: 3150, "catalog-generic": 3160, "catalog-manga": 3170, "catalog-vinyl": 3180,
    "rebrickable-data": 3190, "catalog-lego": 3220 };
  Promise.all(Object.entries(services).map(([nom, port]) =>
    fetch(`http://localhost:${port}/health/ready`, { signal: AbortSignal.timeout(5000) })
      .then((r) => `${nom} ${r.status}`, () => `${nom} injoignable`)))
    .then((lignes) => console.log(lignes.join("\n")));
' 2>&1)
for nom in identity billing connections sharing search catalog-generic catalog-manga catalog-vinyl rebrickable-data catalog-lego; do
  ligne=$(printf '%s\n' "$sondes" | grep "^$nom " || echo "$nom absent")
  verdict "$(attendre "${ligne#* }" 200)" "$nom /health/ready : 200" "${ligne#* }"
done

c=$(podman exec acervatim-services-redis redis-cli ping 2>&1)
verdict "$(attendre "$c" PONG)" "Redis de la constellation : PONG" "$c"

if [ "$echecs" -gt 0 ]; then
  echo "fumee: $echecs controle(s) KO"
  exit 1
fi
echo "fumee: tout est vert"
