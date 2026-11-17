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
- **L'import CSV n'ecrit jamais `ean`, `upc`, `brickset_id` ni `barcode_checked_at`.** Ces
  colonnes appartiennent a la recherche au scan, et un `ON DUPLICATE KEY UPDATE` qui les citerait
  effacerait son travail.
- **Brickset n'est appele qu'au scan d'un code absent du cache** (decision du 2026-11-16) : ni
  code confirme depuis moins de 90 jours, ni code marque inconnu, un appel au plus par code et
  par file. Il n'y a **plus de moissonnage** : ne pas en reintroduire, ni dans le cron ni par une
  route `/admin/*` (quota de 100 appels/jour UTC pour tous).
- **La recherche au scan n'ecrit que ces quatre colonnes**, ne cree jamais de set, n'efface
  jamais un code connu par une valeur vide, et n'ecrit que pour une fiche qui porte le code
  scanne (`carriesCode`) : `query` cherche aussi dans les noms et les numeros.
- **Aucun code de plus de 90 jours n'est servi**, et le passage quotidien les efface : c'est
  l'engagement pris aupres de Brickset. `BRICKSET_BARCODE_TTL_DAYS` est plafonne a 90.
- **Chaque appel Brickset reel est compte** : une seule tentative HTTP par job (`maxAttempts: 1`),
  compteur ecrit avant l'envoi mais apres le controle Redis, cle du jour calculee une fois,
  reservations mises en file (`reserveCall`). La cle API n'entre jamais dans un payload de job
  (Redis) : le worker l'ajoute.
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

- `src/jobs/daily-refresh.service.ts` : le **seul** cron (03:00 UTC) - import, purge du cache,
  effacement des codes de plus de 90 jours, chaque etape meme si la precedente echoue ; meme
  enchainement au demarrage si `lego_sets` est vide (jamais sous `NODE_ENV=test`).
- `src/import/rebrickable-csv.service.ts` : import des quatre CSV (themes, inventaires,
  figurines d'inventaire, sets), en flux.
- `src/catalog/theme-tree.ts` : `slugify`, `uniqueSlug` (255 caracteres), calcul
  path/depth/slug, `ThemeIndex` (descendance ; themes retires exclus des listes et des slugs).
- `src/catalog/catalog.service.ts` : toutes les lectures servies par `/internal/*`.
- `src/brickset/` : `barcode.ts` (variantes EAN/UPC), `brickset-match.ts` (rapprochement d'une
  fiche Brickset et d'un set), client sous budget (`brickset.service.ts`, compteur
  `brickset:budget:YYYY-MM-DD` dans `api_cache`), worker BullMQ (`concurrency: 1`, 1 appel / 2 s,
  une tentative), recherche au scan (`brickset-lookup.service.ts` : cache, codes inconnus
  `brickset:miss:<code>`, single-flight par code, attente bornee).
- `src/admin/admin.controller.ts` : `GET /admin/status`, `POST /admin/import/rebrickable`.
- `src/http-prefix.ts` : les exclusions du prefixe `/v1` (verrouillees par un test).
- `src/common/internal/contracts.ts`, section `rebrickable-data` : les formes servies et leurs
  bornes.

## Running and verifying

- Tout passe par le wrapper de la racine : `../scripts/dev.ps1 up-one rebrickable-data`,
  `../scripts/dev.ps1 test rebrickable-data`, `../scripts/dev.ps1 build-ts rebrickable-data`.
- `npm`, `npx`, `node`, `prisma`, `nest` ne se lancent **jamais** depuis Windows.
- Exploitation : `../scripts/dev.ps1 lego-import [force]`, `lego-scan <code>`, `lego-status`. Un
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

- **`barcode_checked_at` avance a chaque confirmation, meme si les codes n'ont pas change.**
  C'est elle qui fait courir les 90 jours ; ne l'ecrire que sur changement ferait effacer un
  code que Brickset vient de confirmer.
- **Une erreur de Brickset ne marque jamais un code inconnu.** Seule une reponse `success` sans
  fiche utile le fait ; sinon un incident d'une heure bloquerait le scan d'un code pendant
  7 jours.
- **Le scan n'attend Brickset que `BRICKSET_SCAN_WAIT_MS`, mais l'appel continue.** C'est voulu
  (`pending`) : le resultat sert le scan suivant. Ne pas annuler le job au delai, il serait
  compte sans profiter a personne.
- **Le code est cherche sous sa forme la plus courte** (`canonicalCode`) : Brickset publie un
  UPC-A sur 12 chiffres, et un EAN-13 a zero de tete scanne ne le retrouverait pas.
- Les lignes `import_runs` de source `brickset` sont l'historique de l'ancien moissonnage :
  plus jamais ecrites, gardees telles quelles.
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
