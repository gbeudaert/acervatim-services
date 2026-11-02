# Catalog - manga

Collections, noeuds, items et profil de type **manga**.

- **Perimetre** : collections, noeuds et items de type manga, et le profil de ce type.
- **Schema SQL** : `acv_cat_manga` · **Port** : 3170
- **Cible et decoupage** : `../../../acervatim-docs/agent/backend/architecture-microservices.md`
- **Conventions API** : `../../../acervatim-docs/agent/backend/contrats-api-v1.md`

---

## 1. Un service catalog tient en trois fichiers

Tout le CRUD - collections, noeuds, items, pagination, filtrage par statut, routes internes,
plafonds - vient de [`catalog-core`](../catalog-core/README.md). Ce service n'apporte que :

| Fichier | Role |
|---|---|
| [`src/profiles.ts`](src/profiles.ts) | **Les types qu'il sert.** C'est la seule chose qui le distingue des deux autres catalogs. |
| [`prisma/schema.prisma`](prisma/schema.prisma) | Son schema - identique aux deux autres, sur sa propre base. |
| `src/common/`, `src/main.ts`, `src/app.module.ts` | Le socle technique, commun a toute la constellation. |

C'est exactement ce que le 2 de l'architecture annonce : ce qui differe entre deux catalogs
tient dans un `itemSchema`, une `toListProjection`, une `hierarchy` et un `reconcileOnUpdate`
optionnel. Recopier le CRUD ici creerait la divergence que le decoupage cherche a eviter.

### Ce que le profil manga apporte

Un type **hierarchique** : une serie est un noeud, ses tomes sont des items. Le profil declare
donc un niveau `serie`, avec son `nodeSchema` et le `mapSnapshot` qui derive la verite curee
d'un snapshot MAL. Sa `toListProjection` compose le titre d'un tome sans titre propre
(`{serie} - T.{volume}`) - ce qui suppose de lire le noeud parent, d'ou le `node` de la ligne
de projection.

Consequences visibles sur ce catalog, et sur lui seul parmi les trois :
`POST /v1/collections/:id/nodes` a un sens, `nodeId` et `volume` sont acceptes sur un item, et
`GET /v1/collections/:id` rend un resume `hierarchy` non vide.

---

## 2. Ce qu'il doit aux autres services

Un catalog ne decide plus seul. Trois dependances, toutes documentees dans `catalog-core` :

| Vers | Route | Pourquoi |
|---|---|---|
| gateway | `PUT\|DELETE /internal/registry` | Registre de routage (3.3). Sans lui, `GET /v1/items/:id` - dont l'URL ne porte pas le type - repond `404` sur une ressource qui existe. |
| `search` | `POST /internal/sources/snapshot` | Pre-remplissage de la verite curee a l'attachement d'une source. Les adapters ont suivi `search`. |
| `identity` | `POST /internal/audit` | Journal d'audit unique. |

**Aucune n'est bloquante.** Le registre indisponible journalise une erreur et laisse le job de
reparation nocturne rattraper ; `search` indisponible conserve la reference sans enrichissement.
Faire echouer une ecriture parce qu'un voisin ne repond pas priverait l'utilisateur de sa
donnee pour une panne qui ne la concerne pas.

Et une dependance **entrante** : `sharing` interroge
`GET /internal/collections/:id/owner` et `POST /internal/items/count` (3.1, 3.2). C'est
l'inversion qui remplace la jointure SQL que `sharing` faisait sur `items` dans le monolithe.

---

## 3. Ce que le gateway fait a sa place

Les trois gardes du monolithe - `PremiumGuard`, `CollectionPremiumGuard`, `CollectionWriteGuard` -
sont remontees au gateway (3.6). Quand une requete arrive ici, le droit est **deja tranche et
signe** : le principal porte `{ userId, premium, role, statuses }`.

Ce service ne fait donc plus que lire cette decision. C'est voulu : deux endroits qui decident
du meme acces finissent toujours par ne plus dire la meme chose.

L'invariant qui comptait est meme renforce - **les statuts n'ont aucun chemin par lequel
arriver du client** : ils sont dans un jeton signe HMAC, ni forgeable ni modifiable.

---

## 4. Demarrage

```powershell
cd ..                              # backend-services/
./scripts/dev.ps1 link-core        # une fois : jonction vers catalog-core
./scripts/dev.ps1 up-bg
./scripts/dev.ps1 logs catalog-manga
```

`GET /health/ready` expose `types` (ce que ce catalog sert), `counts` et - surtout -
`registry` : si ce dernier vaut `false`, les ressources creees ici **ne seront pas routables**
par le gateway. C'est le mode autonome, utile en developpement, et le symptome qu'il produit
autrement (`404` sur des ressources qui existent) est le plus difficile a diagnostiquer de
toute la cible.

---

## 5. Reste a faire

- **Porter les tests du CRUD** du monolithe. Ils s'appuyaient sur son `PrismaService` et ses
  gardes ; ils doivent revenir dans `catalog-core`, contre le port `CATALOG_DB` - ou ils
  vaudront pour les trois catalogs a la fois.
- **Mesurer p95 de `GET /v1/collections/:id/items`**, l'un des deux points de non-regression
  que le 4 exige avant tout passage de palier.
- **Arbitrer le plafond technique (3.5)** : il ne compte plus que les collections de ce
  catalog, donc un utilisateur multi-types peut atteindre jusqu'a N fois le plafond unitaire.
