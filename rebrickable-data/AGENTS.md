## acervatim-rebrickable-data

Base de reference du catalogue LEGO (NestJS, Prisma, MariaDB) : sets, themes, figurines et
codes-barres. Schema `acv_rebrickable`, port 3190. Service **interne** : ni route `/v1/*`, ni
passage par le gateway. Cible : `../../../acervatim-docs/agent/backend/architecture-microservices.md`.

## Policy

- **Seules routes exposees** : `/internal/*` (`InternalGuard`, `INTERNAL_SERVICE_TOKEN`),
  `/admin/*` (`AdminGuard`, `ADMIN_API_TOKEN`, hors prefixe `v1`) et `/health*`. Ajouter une
  route `/v1/*`, un `/openapi.json` ou un routage gateway est un changement de contrat, pas un
  detail.
- **La seule automatisation vers Rebrickable est le telechargement des CSV** de
  `cdn.rebrickable.com/media/downloads/`, au plus une fois par jour en nominal (un seul cron,
  03:00 **UTC**, + controle `Last-Modified`). Aucun appel a l'API Rebrickable, aucun
  telechargement d'image : ce sont les CGU (5.3), pas une preference.
- **L'import CSV n'ecrit jamais `ean`, `upc` ni `brickset_id`.** Ces colonnes appartiennent au
  moissonnage Brickset, et un `ON DUPLICATE KEY UPDATE` qui les citerait effacerait son travail.
- **Le moissonnage Brickset n'ecrit que ces trois colonnes**, ne cree jamais de set, n'efface
  jamais un code connu par une valeur vide, et n'est **jamais** declenche par une requete de
  lecture (quota de 100 appels/jour UTC pour tous).
- **Chaque appel Brickset reel est compte** : une seule tentative HTTP par job (`maxAttempts: 1`),
  compteur ecrit avant l'envoi mais apres le controle Redis, cle du jour calculee une fois. La
  cle API n'entre jamais dans un payload de job (Redis) : le worker l'ajoute.
- **Ne jamais supprimer un set absent du CSV.** Une reference retiree chez Rebrickable reste
  possedee par quelqu'un.
- **Single-flight intra-processus seulement.** Pas de verrou Redis ou SQL multi-replicas : le
  service tourne en un exemplaire, et c'est voulu.
- Aucune donnee d'utilisateur, aucune `@relation` hors du schema : ce service ne participe pas a
  la saga RGPD et n'expose pas `/internal/users/:id/*`.
- `src/common/**` est **copie a l'identique** de `search`. `contracts.ts` se modifie dans toutes
  ses copies du meme coup (meme md5, `catalog-core/src/contracts.ts` compris).
- Pas de nouvelle dependance sans accord prealable (`csv-parse` est la seule ajoutee au socle).
- Ne nommer aucun materiel ni hebergeur dans le code ou un commentaire.

## Where things are

- `src/jobs/daily-refresh.service.ts` : le **seul** cron (03:00 UTC) - import puis campagne
  Brickset, la seconde meme si l'import echoue ; meme enchainement au demarrage si `lego_sets`
  est vide (jamais sous `NODE_ENV=test`).
- `src/import/rebrickable-csv.service.ts` : import des quatre CSV (themes, inventaires,
  figurines d'inventaire, sets), en flux.
- `src/catalog/theme-tree.ts` : `slugify`, `uniqueSlug` (255 caracteres), calcul
  path/depth/slug, `ThemeIndex` (descendance ; themes retires exclus des listes et des slugs).
- `src/catalog/catalog.service.ts` : toutes les lectures servies par `/internal/*`.
- `src/brickset/` : `barcode.ts` (variantes EAN/UPC), client sous budget (`brickset.service.ts`,
  compteur `brickset:budget:YYYY-MM-DD` dans `api_cache`), worker BullMQ
  (`concurrency: 1`, 1 appel / 2 s, une tentative), campagne reprenable
  (`brickset-harvest.service.ts`).
- `src/admin/admin.controller.ts` : `GET /admin/status`, `POST /admin/import/rebrickable`,
  `POST /admin/harvest/brickset`.
- `src/http-prefix.ts` : les exclusions du prefixe `/v1` (verrouillees par un test).
- `src/common/internal/contracts.ts`, section `rebrickable-data` : les formes servies et leurs
  bornes.

## Running and verifying

- Tout passe par le wrapper de la racine : `../scripts/dev.ps1 up-one rebrickable-data`,
  `../scripts/dev.ps1 test rebrickable-data`, `../scripts/dev.ps1 build-ts rebrickable-data`.
- `npm`, `npx`, `node`, `prisma`, `nest` ne se lancent **jamais** depuis Windows.
- Exploitation : `../scripts/dev.ps1 lego-import [force]`, `lego-brickset`, `lego-status`. Un
  second `lego-import` sans `force` doit rendre `unchanged`.
- **`docker compose restart` ne relit pas `.env`.** Apres modification :
  `docker compose up -d --force-recreate rebrickable-data`.

## Conventions that differ from defaults

- `contributedBy` **se deduit des donnees** (`brickset` si `bricksetId` est renseigne). Pas de
  colonne `sources` : celle de `catalog-lego` derivait.
- Les sets sont ecrits par `INSERT ... ON DUPLICATE KEY UPDATE` en SQL brut, par lots de 1 000 :
  `updated_at` y est gere a la main (Prisma ne l'applique pas au SQL brut) et n'avance que si
  une valeur change.
- Les themes passent aussi par un `ON DUPLICATE KEY UPDATE`, apres liberation des slugs
  convoites : l'ODKU se declenche sur n'importe quelle cle unique, `slug` compris.
- Validation par Zod via `nestjs-zod` (`createZodDto`), erreurs RFC 9457 du socle.

## Known pitfalls

- **Le filigrane Brickset se lit sur le dernier `done`, tout mode confondu.** Le lire sur le
  dernier `full` (comme `catalog-lego`) fait redemander tout le catalogue a chaque incremental.
- **Un run repris passe a `superseded`, et la reprise relit la derniere page consommee.** Sans
  recouvrement, un set insere entre deux jours decale les pages et ceux de la bordure sont
  sautes ; sans `superseded`, les runs en pause restaient ouverts.
- **Les themes ne sont jamais supprimes**, seulement marques `retired_at`. Un slug n'est pas un
  identifiant stable ; le renommage d'un theme retire cherche un slug libre (contre les slugs
  voulus ET existants), faute de quoi l'index unique ferait echouer tous les imports suivants.
- Un CSV `themes`, `inventories` ou `sets` valide mais vide fait echouer le run : ne pas
  « assouplir » cette garde, elle evite de passer toutes les figurines a `NULL`.
- Tout changement de schema passe par une **nouvelle** migration : l'init est deja appliquee.
- `minifigs` vaut `0` quand l'inventaire de plus petite version n'a pas de figurine (cas de
  tous les Technic, et des coffrets dont les figurines sont dans des sous-sets
  `inventory_sets`, non suivis), et `null` seulement sans inventaire.
- La base `acv_rebrickable` n'est creee par `db/init/01-schemas.sql` qu'a la **premiere**
  creation du volume. Sur un volume existant, `prisma migrate deploy` (au demarrage du conteneur)
  la cree, l'utilisateur de dev ayant les droits globaux.
- PowerShell 5.1 : ni `&&` ni `||` (utiliser `; if ($?) { ... }`). Sources `.ps1` en ASCII pur.
