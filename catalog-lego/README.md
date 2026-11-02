# acervatim-backend-lego

Service catalogue **LEGO** d'Acervatim : recherche et identification de sets par **nom**, par
**code-barres** et par **type de set** (Technic, Architecture, City...).

C'est le premier service ecrit selon la cible micro-services
(`../acervatim-docs/agent/backend/architecture-microservices.md`). Il tourne seul aujourd'hui, et
se range derriere le `gateway` sans reecriture le jour ou celui-ci existe.

---

## 1. Ce que ce depot contient - et ce qu'il ne contient pas

**Contenu** : le socle API complet (Zod, RFC 9457, pagination cursor, throttler, access log,
principal signe, files BullMQ, cache DB, sante/readiness), la verticale source LEGO
(Rebrickable + Brickset + index local), les routes `/internal/*` de la saga RGPD.

**Absent volontairement** : le CRUD `collections` / `collection_nodes` / `items`.

Ce n'est pas un oubli. La cible dit que ce CRUD est **identique entre types** et qu'il doit venir
d'une bibliotheque partagee (`libs/catalog-core`, jalon M0 puis M6), pas d'un fork. Le recopier
ici creerait exactement la divergence que le decoupage cherche a eviter : deux implementations du
meme CRUD, qui derivent au premier correctif applique d'un seul cote. Tant que `catalog-core`
n'est pas extrait, une collection LEGO se stocke dans le monolithe, qui appelle ce service pour
la recherche - c'est-a-dire le meme rapport que `search` entretient deja avec `collections`.

Ce qui n'existait nulle part et qui existe ici, c'est la **verticale LEGO** : aucune source LEGO
n'etait branchee dans le monolithe, et le probleme central du scan (§3) n'y avait pas de reponse.

---

## 2. Demarrage

```powershell
Copy-Item .env.example .env      # puis remplir (voir les commentaires du fichier)
./scripts/dev.ps1 build
./scripts/dev.ps1 up-bg
./scripts/dev.ps1 migrate-deploy
```

Ports : API `3010`, MariaDB `3307`, Redis `6380` - decales pour cohabiter avec la stack du
monolithe. `npm`/`npx`/`prisma` ne se lancent jamais depuis Windows : `./scripts/dev.ps1 help`
liste les passe-plats.

Deux cles a obtenir :

| Cle | Ou | Pourquoi |
|---|---|---|
| `REBRICKABLE_API_KEY` | compte Rebrickable > Settings > API (libre-service, immediat) | catalogue |
| `BRICKSET_API_KEY` | `brickset.com/tools/webservices/requestkey` (sur demande) | codes-barres |

Sans `REBRICKABLE_API_KEY` et sans cle personnelle, la recherche texte repond `403
source-token-required` - le mode degrade nominal. Sans `BRICKSET_API_KEY`, tout fonctionne sauf
le scan : l'index se construit sans codes-barres.

---

## 3. Le choix des sources

C'est la question de fond du service, et elle a une reponse contre-intuitive.

### Le paysage

| Source | Catalogue | Recherche par nom | Type de set | Code-barres | Acces | Quota |
|---|---|---|---|---|---|---|
| **Rebrickable** | complet | oui (`search=`) | oui (`theme_id`, arbre complet) | **non** | cle gratuite en libre-service | ~1 req/s |
| **Brickset** | complet | oui (`query`) | oui (`theme`) | **oui (EAN + UPC)** | cle sur demande | **100 `getSets`/jour** |
| **BrickOwl** | complet | non documentee | non | non (ids maison) | cle | 10 000/jour |
| **BrickLink** | complet | oui | oui | non | OAuth 1.0a + IP declaree | - |

### Le probleme

Les trois capacites demandees ne sont pas fournies par la meme source, et celle qui detient la
plus critique est la moins interrogeable :

- **par nom et par type** : Rebrickable repond, avec un quota exploitable en ligne ;
- **par code-barres** : **aucune source ne le fait**. Brickset *publie* l'EAN/UPC mais ne permet
  pas de chercher dessus, et 100 appels/jour interdisent de toute facon l'appel interactif - un
  seul utilisateur qui scanne consommerait le quota de tous les autres.

### La reponse retenue

On retourne le probleme : **Brickset n'est jamais appele en ligne, il est moissonne hors ligne**.

```
Rebrickable  --nocturne-->  lego_sets  (nom, annee, theme, pieces, visuel)
Brickset     --nocturne-->  lego_sets  (ean, upc)          <- 45 appels pour tout le catalogue
                                |
scan EAN --------------------> lecture locale, cout reseau nul
recherche nom ---------------> Rebrickable en ligne, index local en repli degrade
recherche type --------------> index local (seul a porter l'arbre des themes)
```

A `pageSize: 500` (le maximum), le catalogue entier tient en **~45 appels** - une nuit. Ensuite,
`updatedSince` ramene le cout quotidien a quelques appels. `HarvestRun` memorise la derniere page
consommee : si le budget s'epuise en cours de route, la campagne **reprend a la page suivante**,
jamais au debut. C'est la condition pour que le moissonnage tienne sous un quota journalier.

Trois consequences a assumer, plutot qu'a decouvrir plus tard :

1. **Le scan ne marche qu'apres moissonnage.** Un index vide repond 200 avec une liste vide, pas
   une erreur. `GET /admin/lego/index` donne `sets.withBarcode` pour le savoir.
2. **Le filtre par type passe par l'index, et c'est un choix, pas un repli.** Le `theme_id` de
   Rebrickable est un filtre *exact* ; un utilisateur qui demande "technic" attend aussi les
   trente sous-themes. Seul l'index, qui porte l'arbre, repond a la question posee.
3. **Les codes-barres se degradent silencieusement si Brickset est absent.** D'ou l'avertissement
   au boot, et `brickset.configured` dans l'etat de l'index.

Effet de bord voulu : toute recherche en ligne alimente l'index. Le catalogue se remplit donc au
fil de l'usage, meme si le passage nocturne n'a jamais tourne.

---

## 4. API

Le contrat est celui du monolithe (`contrats-api-v1.md`) : prefixe `/v1`, Problem Details RFC
9457 sous les memes URI `type`, pagination cursor opaque.

### Recherche

```
GET /v1/search?type=lego&q=bulldozer[&cursor=&limit=]
GET /v1/search?type=lego&barcode=5702016616331
GET /v1/search?type=lego&theme=technic[&q=grue]
GET /v1/search/themes[?parent=technic]
GET /v1/search/sets/42131-1
```

`type=lego` est exige bien que le service ne serve que ce type : c'est le gateway qui route sur
`type`, l'app doit envoyer la meme requete qu'aujourd'hui. `barcode` ne se combine ni avec `q` ni
avec `theme` - un code-barres designe une boite.

Reponse :

```json
{
  "data": [ { "source": "rebrickable", "sourceId": "42131-1", "mediaType": "lego",
              "title": "App-Controlled Cat D11 Bulldozer", "creators": [],
              "releaseDate": "2021", "coverUrl": "...",
              "metadata": { "setNum": "42131-1", "setNumber": "42131",
                            "theme": { "id": 1, "name": "Technic", "path": "Technic" },
                            "numParts": 3854, "minifigs": null,
                            "barcodes": { "ean": "5702016616331", "upc": null },
                            "contributedBy": ["brickset", "rebrickable"] } } ],
  "meta": { "pagination": { "nextCursor": "eyJwIjoyfQ", "limit": 50 },
            "source": "rebrickable", "degraded": false }
}
```

`meta.source` et `meta.degraded` sont des extensions additives : sans elles, un resultat pauvre
servi en mode degrade serait indiscernable d'un catalogue vide.

`creators` reste **vide** - un set n'a pas d'auteur expose par les catalogues. Le profil de type
LEGO doit projeter `metadata.theme.path` comme sous-titre plutot que de faire mentir le champ.

### Sources (BYOT)

```
GET    /v1/sources
PUT    /v1/sources/rebrickable/token   { "token": "..." }   -> 204
DELETE /v1/sources/rebrickable/token                        -> 204
```

Rebrickable n'a pas d'OAuth : la cle se colle, comme TMDB dans le monolithe. Brickset est
volontairement refuse (400) - sa cle est une ressource du service, pas une source qu'on connecte.

### Exploitation et routes internes

```
GET  /health · /health/ready
GET  /admin/lego/index                 etat de l'index, budget Brickset, dernieres campagnes
POST /admin/lego/index/rebrickable     moissonne le catalogue
POST /admin/lego/index/brickset        moissonne les codes-barres (dans la limite du budget)
POST /admin/lego/themes/sync           synchronise l'arbre des themes
DELETE /internal/users/:id/data        participant de la saga RGPD, idempotent
GET    /internal/users/:id/export      fragment d'export RGPD
```

`/admin/*` et `/internal/*` sont hors `/v1` et hors throttler, protegees par `ADMIN_API_TOKEN`.
Dans la cible, `/internal/*` passe au secret de service a service et n'est jamais expose par le
gateway.

---

## 5. Resolution des jetons

Meme logique que le monolithe, transposee (`sources-externes.md`) :

1. **cle personnelle** (BYOT) presente -> on l'utilise ;
2. sinon **premium** -> cle serveur Acervatim ;
3. sinon **mode degrade** -> index local et cache ; si les deux sont vides, `403
   source-token-required` avec `provider`, que l'app traduit en « connecter la source ou passer
   premium ».

`TokenResolverPort` est un **port** : dans la cible, ces credentials appartiennent a
`connections` et se resolvent par `GET /internal/token/:userId/:provider`. Le jour venu, seule la
ligne `useClass` de `common/sources/sources.module.ts` change.

En mode autonome (pas de gateway), `premium` vaut toujours `false` : ce service ne peut pas
interroger `billing`, et supposer un droit qu'on ne sait pas verifier serait pire que le degrader.

---

## 6. Ce qui est deja aligne sur la cible

| Point de l'architecture | Etat ici |
|---|---|
| Schema logique dedie, aucune FK inter-schemas | fait (`acv_cat_lego`, `userId` sans relation) |
| Principal signe `X-Acervatim-Principal` (3.6) | fait (`PrincipalGuard` + codec HMAC), avec repli JWT |
| Saga RGPD, participants idempotents (3.4) | fait (`DELETE|GET /internal/users/:id/...`) |
| Contrat public inchange (5) | fait (`/v1/search?type=lego`, memes URI d'erreur) |
| Resolution de jeton derriere un port (6) | fait (`TokenResolverPort`) |
| CRUD catalog depuis `libs/catalog-core` | **non** - a venir de l'extraction, pas d'un fork (§1) |
| Registre de routage `collectionId -> typeCode` (3.3) | hors perimetre : appartient au gateway |

---

## 7. Reste a faire

- **Obtenir les deux cles** et lancer un premier moissonnage complet : c'est ce qui fera passer le
  scan de « code ecrit » a « fonctionnalite verifiee ». Aucun appel Rebrickable ou Brickset reussi
  n'a pu etre observe faute de cle - seule la chaine file -> worker -> HTTP sortant a ete validee
  de bout en bout (Rebrickable repond 401 sur une cle bidon, traduit en 502).
- **Mesurer la couverture du rapprochement** Brickset -> Rebrickable. La jointure repose sur
  `number` + `numberVariant` -> `set_num`. Le taux de correspondance reel est inconnu et
  conditionne la couverture du scan ; c'est la premiere mesure a produire apres le moissonnage.
- **Page `agent/` dans acervatim-docs** pour ce service, et une ligne LEGO dans
  `transverse/sources-externes.md`.
- **Profil de type LEGO cote app** (projection de liste, sous-titre = `metadata.theme.path`,
  ecran de choix quand un code-barres renvoie plusieurs sets).
- Verrou Redis sur le moissonnage si le service passe a plusieurs replicas (le verrou actuel est
  intra-processus).
