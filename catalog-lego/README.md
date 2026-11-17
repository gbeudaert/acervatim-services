# Catalog - LEGO

Collections, items et profil de type **LEGO**.

- **Perimetre** : collections et items de type `lego` (un item est une boite), et le profil de
  ce type. Le catalogue des sets n'est pas ici : il vit dans [`rebrickable-data`](../rebrickable-data/README.md).
- **Schema SQL** : `acv_cat_lego` · **Port** : 3220
- **Conception** : `../../../acervatim-docs/_bmad-output/implementation-artifacts/spec-collection-lego.md`
- **Cible et decoupage** : `../../../acervatim-docs/agent/backend/architecture-microservices.md`
- **Conventions API** : `../../../acervatim-docs/agent/backend/contrats-api-v1.md`

---

## 1. Un service catalog tient en trois fichiers

Ce service est un clone de [`catalog-vinyl`](../catalog-vinyl/README.md), refait le 2026-11-17.
Tout le CRUD - collections, items, pagination, filtrage par statut, routes internes, plafonds,
saga RGPD - vient de [`catalog-core`](../catalog-core/README.md). Ce service n'apporte que :

| Fichier | Role |
|---|---|
| [`src/profiles.ts`](src/profiles.ts) | **Le type qu'il sert.** C'est la seule chose qui le distingue des autres catalogs. |
| [`prisma/schema.prisma`](prisma/schema.prisma) | Son schema - identique a celui des autres catalogs, octet pour octet, sur sa propre base. |
| `src/common/`, `src/main.ts`, `src/app.module.ts` | Le socle technique, commun a toute la constellation. |

### Ce que le profil LEGO apporte

Un type **plat** : un item est une boite, deux exemplaires du meme set sont deux items.
`node`, `nodeId` et `volume` sont refuses en `400`.

`unifiedData` (schema strict, `catalog-core/src/types/lego.ts`) : `title`, `setNumber` (le
numero imprime sur la boite, `42131`), `year`, `theme` (chemin `Technic / Star Wars`),
`themeId`, `numParts`, `minifigs`, `coverUrl`. La liste projette `title`, `setNumber`, `year`,
`theme`, `coverUrl` et `status` ; pas de `playCount`, qui n'a pas de sens pour une boite.

Les identifiants externes vont dans `sources[]`, comme pour le vinyle : le numero canonique
Rebrickable (`provider: 'rebrickable'`, `externalId: '42131-1'`), et le code-barres scanne
(`provider: 'barcode'`). Un `POST /v1/items` avec une source `rebrickable` fait remplir le
snapshot par `search`, qui le lit dans `rebrickable-data`.

Pas de donnee perso propre au LEGO (boite scellee, montee, incomplete) pour l'instant : le
champ `note` suffit d'abord (decision du 2026-11-17). Le jour venu, elles passeront par un
schema `userData` porte par le profil, a ajouter dans `catalog-core`.

---

## 2. Ce qu'il doit aux autres services

Les memes dependances que tout catalog, documentees dans `catalog-core` :

| Vers | Route | Pourquoi |
|---|---|---|
| gateway | `PUT\|DELETE /internal/registry` | Registre de routage (3.3). Sans lui, `GET /v1/items/:id` - dont l'URL ne porte pas le type - repond `404` sur une ressource qui existe. |
| `search` | `POST /internal/sources/snapshot` | Pre-remplissage du snapshot a l'attachement d'une source `rebrickable`. |
| `identity` | `POST /internal/audit` | Journal d'audit unique. |

**Aucune n'est bloquante**, comme pour les autres catalogs.

Dependances **entrantes** : `sharing` (`GET /internal/collections/:id/owner`,
`POST /internal/items/count`) et `identity`, qui l'appelle dans la saga RGPD (export puis
`DELETE /internal/users/:id/data`).

Ce service n'appelle **ni Rebrickable ni Brickset**, et n'a aucune cle de source. La recherche
d'un set (texte ou code-barres) passe par `GET /v1/search?type=lego`, servie par `search`, qui
lit `rebrickable-data`.

---

## 3. Demarrage

```powershell
cd ..                              # backend-services/
./scripts/dev.ps1 link-core        # une fois : jonction vers catalog-core
./scripts/dev.ps1 up-bg
./scripts/dev.ps1 logs catalog-lego
```

`GET /health/ready` expose `types` (`['lego']`), `counts` et `registry` : si ce dernier vaut
`false`, les ressources creees ici ne seront pas routables par le gateway.

---

## 4. Reste a faire

- Les memes points que les autres catalogs (tests du CRUD dans `catalog-core`, mesure p95,
  plafond technique par catalog) : voir [`catalog-vinyl`](../catalog-vinyl/README.md#5-reste-a-faire).
- **Filtre par theme** dans `GET /v1/search?type=lego` : apres la bascule (decision du
  2026-11-17). `rebrickable-data` sait deja filtrer, mais `/v1/search` exige `q` ou `barcode`.
- **Images** : URL Rebrickable servies telles quelles. Ce sont des images de LEGO ; leur usage
  dans une application a palier payant est `pending`.
