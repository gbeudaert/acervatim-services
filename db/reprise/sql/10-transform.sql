-- Repartition des donnees du monolithe (schema de transit `acv_legacy`) dans les schemas de la
-- constellation. Joue par `reprise.sh transform`, apres 00-preconditions.sql.
--
-- **Une seule transaction.** Toutes les tables sont InnoDB sur la meme instance : le client
-- `mariadb` s'arrete a la premiere erreur, la connexion se ferme sans COMMIT et le serveur
-- annule tout. Il n'existe donc pas d'etat « a moitie repris » a nettoyer.
--
-- Ce que la reprise transforme, et seulement cela :
--   - `collections.type_id` devient `type_code`, et chaque collection part dans le catalog qui
--     sert son type (`CATALOG_BY_TYPE`, gateway/src/routing/service-registry.service.ts) ;
--   - `collection_share_entries` recoit le nom et le type de sa collection, que `sharing` garde
--     en copie faute de pouvoir joindre `collections` ;
--   - le registre de routage du gateway est rempli d'apres les collections, items et noeuds
--     repris - exactement ce que les catalogs lui auraient declare un par un ;
--   - du cache, seul l'etat du rattrapage manga (`edition-watch:*`) est repris : c'est un etat
--     (derniere verification, tomes detectes), pas une reponse d'API qui se reconstitue.
-- Tout le reste est copie colonne pour colonne : les types SQL sont identiques des deux cotes.
--
-- Ce qui n'est PAS repris :
--   - `collection_types` : la migration d'identity la remplit deja, et plus rien n'y fait
--     reference ;
--   - le reste d'`api_cache` (reponses d'API, etats de liaison OAuth de quelques minutes) ;
--   - `_prisma_migrations` du monolithe, sans objet ici.

-- Toute troncature ou valeur invalide est une erreur, jamais un avertissement.
SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
SET SESSION foreign_key_checks = 1;

-- Profondeur de chaque noeud dans sa hierarchie. `collection_nodes.parent_id` est une FK vers
-- la meme table, verifiee ligne a ligne : un enfant insere avant son parent est refuse. Inserer
-- par profondeur croissante est la seule facon de garder la FK active pendant la copie au lieu
-- de la couper et d'esperer. Un noeud dont la chaine de parents est rompue n'a pas de
-- profondeur : il ne serait pas copie, et 20-verify.sql le signalerait par un ecart de compte.
CREATE TEMPORARY TABLE acv_legacy.reprise_node_depth (
  id CHAR(36) NOT NULL PRIMARY KEY,
  depth INT NOT NULL
);
INSERT INTO acv_legacy.reprise_node_depth (id, depth)
WITH RECURSIVE tree AS (
  SELECT id, 0 AS depth FROM acv_legacy.collection_nodes WHERE parent_id IS NULL
  UNION ALL
  SELECT n.id, tree.depth + 1
  FROM acv_legacy.collection_nodes n
  JOIN tree ON n.parent_id = tree.id
)
SELECT id, depth FROM tree;

START TRANSACTION;

-- ------------------------------------------------------------------------------ identity

INSERT INTO acv_core.users (id, google_sub_hash, created_at, updated_at)
SELECT id, google_sub_hash, created_at, updated_at
FROM acv_legacy.users;

INSERT INTO acv_core.audit_logs (id, user_id, action, target, metadata, created_at)
SELECT id, user_id, action, target, metadata, created_at
FROM acv_legacy.audit_logs;

-- ------------------------------------------------------------------------------ billing

INSERT INTO acv_billing.subscriptions
  (user_id, status, product_id, purchase_token, expires_at, auto_renew, started_at,
   last_verified_at, cancel_reason)
SELECT user_id, status, product_id, purchase_token, expires_at, auto_renew, started_at,
       last_verified_at, cancel_reason
FROM acv_legacy.subscriptions;

INSERT INTO acv_billing.premium_grants (user_id, reason, granted_by, granted_at, expires_at, notes)
SELECT user_id, reason, granted_by, granted_at, expires_at, notes
FROM acv_legacy.premium_grants;

INSERT INTO acv_billing.invitations
  (code_hash, reason, grants_premium, premium_expires_at, max_uses, used_count, expires_at,
   created_by, notes, created_at)
SELECT code_hash, reason, grants_premium, premium_expires_at, max_uses, used_count, expires_at,
       created_by, notes, created_at
FROM acv_legacy.invitations;

INSERT INTO acv_billing.invitation_redemptions (invitation_code_hash, user_id, redeemed_at)
SELECT invitation_code_hash, user_id, redeemed_at
FROM acv_legacy.invitation_redemptions;

-- -------------------------------------------------------------------------- connections

-- Les jetons restent chiffres tels quels : `connections` doit tourner avec le meme
-- ENCRYPTION_KEY que le monolithe, sinon ils sont illisibles (README.md, 2).
INSERT INTO acv_conn.oauth_credentials
  (user_id, provider, access_token_encrypted, refresh_token_encrypted, expires_at, scopes,
   encrypted_with_key_version, updated_at)
SELECT user_id, provider, access_token_encrypted, refresh_token_encrypted, expires_at, scopes,
       encrypted_with_key_version, updated_at
FROM acv_legacy.oauth_credentials;

-- ------------------------------------------------------------------------------ sharing

INSERT INTO acv_sharing.collection_shares
  (id, owner_user_id, code_hash, label, max_uses, used_count, expires_at, revoked_at, created_at)
SELECT id, owner_user_id, code_hash, label, max_uses, used_count, expires_at, revoked_at, created_at
FROM acv_legacy.collection_shares;

INSERT INTO acv_sharing.collection_share_entries
  (share_id, collection_id, statuses, collection_name, type_code)
SELECT e.share_id, e.collection_id, e.statuses, c.name, t.code
FROM acv_legacy.collection_share_entries e
JOIN acv_legacy.collections c ON c.id = e.collection_id
JOIN acv_legacy.collection_types t ON t.id = c.type_id;

INSERT INTO acv_sharing.collection_share_members
  (share_id, member_user_id, label, redeemed_at, revoked_at)
SELECT share_id, member_user_id, label, redeemed_at, revoked_at
FROM acv_legacy.collection_share_members;

-- ------------------------------------------------------------------------------- search

-- Lignes expirees comprises : le lecteur du cache les ignore et la purge les retire, et les
-- filtrer ici ferait dependre le controle de l'heure a laquelle il tourne.
INSERT INTO acv_search.api_cache (cache_key, payload, fetched_at, expires_at)
SELECT cache_key, payload, fetched_at, expires_at
FROM acv_legacy.api_cache
WHERE cache_key LIKE 'edition-watch:%';

-- ----------------------------------------------------------------------------- catalogs
-- Trois blocs identiques au filtre de type pres. Ordre impose par les FK internes a chaque
-- catalog : collections, puis noeuds par profondeur, puis items.

-- catalog-manga : manga
INSERT INTO acv_cat_manga.collections
  (id, user_id, type_code, name, description, item_count, created_at, updated_at)
SELECT c.id, c.user_id, t.code, c.name, c.description, c.item_count, c.created_at, c.updated_at
FROM acv_legacy.collections c
JOIN acv_legacy.collection_types t ON t.id = c.type_id
WHERE t.code = 'manga';

INSERT INTO acv_cat_manga.collection_nodes
  (id, collection_id, user_id, parent_id, level, unified_data, sources, user_data, is_wishlist,
   created_at, updated_at)
SELECT n.id, n.collection_id, n.user_id, n.parent_id, n.level, n.unified_data, n.sources,
       n.user_data, n.is_wishlist, n.created_at, n.updated_at
FROM acv_legacy.collection_nodes n
JOIN acv_legacy.reprise_node_depth d ON d.id = n.id
JOIN acv_legacy.collections c ON c.id = n.collection_id
JOIN acv_legacy.collection_types t ON t.id = c.type_id
WHERE t.code = 'manga'
ORDER BY d.depth, n.id;

INSERT INTO acv_cat_manga.items
  (id, collection_id, user_id, node_id, volume, unified_data, sources, user_data, created_at,
   updated_at)
SELECT i.id, i.collection_id, i.user_id, i.node_id, i.volume, i.unified_data, i.sources,
       i.user_data, i.created_at, i.updated_at
FROM acv_legacy.items i
JOIN acv_legacy.collections c ON c.id = i.collection_id
JOIN acv_legacy.collection_types t ON t.id = c.type_id
WHERE t.code = 'manga';

-- catalog-vinyl : vinyl
INSERT INTO acv_cat_vinyl.collections
  (id, user_id, type_code, name, description, item_count, created_at, updated_at)
SELECT c.id, c.user_id, t.code, c.name, c.description, c.item_count, c.created_at, c.updated_at
FROM acv_legacy.collections c
JOIN acv_legacy.collection_types t ON t.id = c.type_id
WHERE t.code = 'vinyl';

INSERT INTO acv_cat_vinyl.collection_nodes
  (id, collection_id, user_id, parent_id, level, unified_data, sources, user_data, is_wishlist,
   created_at, updated_at)
SELECT n.id, n.collection_id, n.user_id, n.parent_id, n.level, n.unified_data, n.sources,
       n.user_data, n.is_wishlist, n.created_at, n.updated_at
FROM acv_legacy.collection_nodes n
JOIN acv_legacy.reprise_node_depth d ON d.id = n.id
JOIN acv_legacy.collections c ON c.id = n.collection_id
JOIN acv_legacy.collection_types t ON t.id = c.type_id
WHERE t.code = 'vinyl'
ORDER BY d.depth, n.id;

INSERT INTO acv_cat_vinyl.items
  (id, collection_id, user_id, node_id, volume, unified_data, sources, user_data, created_at,
   updated_at)
SELECT i.id, i.collection_id, i.user_id, i.node_id, i.volume, i.unified_data, i.sources,
       i.user_data, i.created_at, i.updated_at
FROM acv_legacy.items i
JOIN acv_legacy.collections c ON c.id = i.collection_id
JOIN acv_legacy.collection_types t ON t.id = c.type_id
WHERE t.code = 'vinyl';

-- catalog-generic : movie, book, game
INSERT INTO acv_cat_generic.collections
  (id, user_id, type_code, name, description, item_count, created_at, updated_at)
SELECT c.id, c.user_id, t.code, c.name, c.description, c.item_count, c.created_at, c.updated_at
FROM acv_legacy.collections c
JOIN acv_legacy.collection_types t ON t.id = c.type_id
WHERE t.code IN ('movie', 'book', 'game');

INSERT INTO acv_cat_generic.collection_nodes
  (id, collection_id, user_id, parent_id, level, unified_data, sources, user_data, is_wishlist,
   created_at, updated_at)
SELECT n.id, n.collection_id, n.user_id, n.parent_id, n.level, n.unified_data, n.sources,
       n.user_data, n.is_wishlist, n.created_at, n.updated_at
FROM acv_legacy.collection_nodes n
JOIN acv_legacy.reprise_node_depth d ON d.id = n.id
JOIN acv_legacy.collections c ON c.id = n.collection_id
JOIN acv_legacy.collection_types t ON t.id = c.type_id
WHERE t.code IN ('movie', 'book', 'game')
ORDER BY d.depth, n.id;

INSERT INTO acv_cat_generic.items
  (id, collection_id, user_id, node_id, volume, unified_data, sources, user_data, created_at,
   updated_at)
SELECT i.id, i.collection_id, i.user_id, i.node_id, i.volume, i.unified_data, i.sources,
       i.user_data, i.created_at, i.updated_at
FROM acv_legacy.items i
JOIN acv_legacy.collections c ON c.id = i.collection_id
JOIN acv_legacy.collection_types t ON t.id = c.type_id
WHERE t.code IN ('movie', 'book', 'game');

-- ------------------------------------------------------------------------------ gateway
-- Ce que chaque catalog declare au registre a chaque creation (`kind` item | node). Le
-- remplir ici plutot que par le job de reconstruction garde la reprise atomique ; le job,
-- lance ensuite par `reprise.sh registry`, sert alors de controle independant : il doit
-- trouver zero ecart.

INSERT INTO acv_gateway.collection_registry (collection_id, user_id, type_code, updated_at)
SELECT c.id, c.user_id, t.code, UTC_TIMESTAMP(3)
FROM acv_legacy.collections c
JOIN acv_legacy.collection_types t ON t.id = c.type_id;

INSERT INTO acv_gateway.resource_registry (resource_id, kind, collection_id, updated_at)
SELECT id, 'item', collection_id, UTC_TIMESTAMP(3) FROM acv_legacy.items
UNION ALL
SELECT id, 'node', collection_id, UTC_TIMESTAMP(3) FROM acv_legacy.collection_nodes;

COMMIT;
