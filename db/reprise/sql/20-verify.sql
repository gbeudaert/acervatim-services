-- Controle de la reprise : source (`acv_legacy`) contre cible, table par table.
--
-- Chaque ligne du rapport : etape, objet, source, cible, statut. `reprise.sh` echoue des
-- qu'un statut commence par KO ; INFO signale un constat qui ne bloque pas.
--
-- **Deux mesures par table** : le nombre de lignes, et une empreinte du contenu - le XOR, sur
-- toutes les lignes, des 64 premiers bits du SHA-1 de chaque ligne (colonnes passees par
-- QUOTE, qui distingue NULL de la chaine 'NULL'). Le XOR ne depend pas de l'ordre des lignes ;
-- l'empreinte attrape ce qu'un simple compte laisse passer : un texte tronque, un accent
-- altere par une conversion de jeu de caracteres, une date qui a perdu ses millisecondes.
-- `KO` = ecart de compte, `KO contenu` = meme compte, contenu different.
--
-- Viennent ensuite des **invariants** que la constellation suppose et que plus aucune FK ne
-- garantit, puisque les schemas sont separes : chaque collection dans un seul catalog, le bon,
-- copies de `sharing` conformes aux catalogs, aucun `userId` orphelin.

-- ------------------------------------------------------------------------- copies 1 pour 1

SELECT 'verification', 'acv_core.users', s.n, c.n,
       IF(s.n <> c.n, 'KO', IF(s.h <> c.h, 'KO contenu', 'OK'))
FROM (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(id), QUOTE(google_sub_hash), QUOTE(created_at), QUOTE(updated_at))), 16), 16, 10) AS UNSIGNED)) h FROM acv_legacy.users) s
CROSS JOIN (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(id), QUOTE(google_sub_hash), QUOTE(created_at), QUOTE(updated_at))), 16), 16, 10) AS UNSIGNED)) h FROM acv_core.users) c

UNION ALL
SELECT 'verification', 'acv_core.audit_logs', s.n, c.n,
       IF(s.n <> c.n, 'KO', IF(s.h <> c.h, 'KO contenu', 'OK'))
FROM (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(id), QUOTE(user_id), QUOTE(action), QUOTE(target), QUOTE(metadata), QUOTE(created_at))), 16), 16, 10) AS UNSIGNED)) h FROM acv_legacy.audit_logs) s
CROSS JOIN (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(id), QUOTE(user_id), QUOTE(action), QUOTE(target), QUOTE(metadata), QUOTE(created_at))), 16), 16, 10) AS UNSIGNED)) h FROM acv_core.audit_logs) c

UNION ALL
SELECT 'verification', 'acv_billing.subscriptions', s.n, c.n,
       IF(s.n <> c.n, 'KO', IF(s.h <> c.h, 'KO contenu', 'OK'))
FROM (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(user_id), QUOTE(status), QUOTE(product_id), QUOTE(purchase_token), QUOTE(expires_at), QUOTE(auto_renew), QUOTE(started_at), QUOTE(last_verified_at), QUOTE(cancel_reason))), 16), 16, 10) AS UNSIGNED)) h FROM acv_legacy.subscriptions) s
CROSS JOIN (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(user_id), QUOTE(status), QUOTE(product_id), QUOTE(purchase_token), QUOTE(expires_at), QUOTE(auto_renew), QUOTE(started_at), QUOTE(last_verified_at), QUOTE(cancel_reason))), 16), 16, 10) AS UNSIGNED)) h FROM acv_billing.subscriptions) c

UNION ALL
SELECT 'verification', 'acv_billing.premium_grants', s.n, c.n,
       IF(s.n <> c.n, 'KO', IF(s.h <> c.h, 'KO contenu', 'OK'))
FROM (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(user_id), QUOTE(reason), QUOTE(granted_by), QUOTE(granted_at), QUOTE(expires_at), QUOTE(notes))), 16), 16, 10) AS UNSIGNED)) h FROM acv_legacy.premium_grants) s
CROSS JOIN (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(user_id), QUOTE(reason), QUOTE(granted_by), QUOTE(granted_at), QUOTE(expires_at), QUOTE(notes))), 16), 16, 10) AS UNSIGNED)) h FROM acv_billing.premium_grants) c

UNION ALL
SELECT 'verification', 'acv_billing.invitations', s.n, c.n,
       IF(s.n <> c.n, 'KO', IF(s.h <> c.h, 'KO contenu', 'OK'))
FROM (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(code_hash), QUOTE(reason), QUOTE(grants_premium), QUOTE(premium_expires_at), QUOTE(max_uses), QUOTE(used_count), QUOTE(expires_at), QUOTE(created_by), QUOTE(notes), QUOTE(created_at))), 16), 16, 10) AS UNSIGNED)) h FROM acv_legacy.invitations) s
CROSS JOIN (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(code_hash), QUOTE(reason), QUOTE(grants_premium), QUOTE(premium_expires_at), QUOTE(max_uses), QUOTE(used_count), QUOTE(expires_at), QUOTE(created_by), QUOTE(notes), QUOTE(created_at))), 16), 16, 10) AS UNSIGNED)) h FROM acv_billing.invitations) c

UNION ALL
SELECT 'verification', 'acv_billing.invitation_redemptions', s.n, c.n,
       IF(s.n <> c.n, 'KO', IF(s.h <> c.h, 'KO contenu', 'OK'))
FROM (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(invitation_code_hash), QUOTE(user_id), QUOTE(redeemed_at))), 16), 16, 10) AS UNSIGNED)) h FROM acv_legacy.invitation_redemptions) s
CROSS JOIN (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(invitation_code_hash), QUOTE(user_id), QUOTE(redeemed_at))), 16), 16, 10) AS UNSIGNED)) h FROM acv_billing.invitation_redemptions) c

UNION ALL
SELECT 'verification', 'acv_conn.oauth_credentials', s.n, c.n,
       IF(s.n <> c.n, 'KO', IF(s.h <> c.h, 'KO contenu', 'OK'))
FROM (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(user_id), QUOTE(provider), QUOTE(access_token_encrypted), QUOTE(refresh_token_encrypted), QUOTE(expires_at), QUOTE(scopes), QUOTE(encrypted_with_key_version), QUOTE(updated_at))), 16), 16, 10) AS UNSIGNED)) h FROM acv_legacy.oauth_credentials) s
CROSS JOIN (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(user_id), QUOTE(provider), QUOTE(access_token_encrypted), QUOTE(refresh_token_encrypted), QUOTE(expires_at), QUOTE(scopes), QUOTE(encrypted_with_key_version), QUOTE(updated_at))), 16), 16, 10) AS UNSIGNED)) h FROM acv_conn.oauth_credentials) c

UNION ALL
SELECT 'verification', 'acv_sharing.collection_shares', s.n, c.n,
       IF(s.n <> c.n, 'KO', IF(s.h <> c.h, 'KO contenu', 'OK'))
FROM (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(id), QUOTE(owner_user_id), QUOTE(code_hash), QUOTE(label), QUOTE(max_uses), QUOTE(used_count), QUOTE(expires_at), QUOTE(revoked_at), QUOTE(created_at))), 16), 16, 10) AS UNSIGNED)) h FROM acv_legacy.collection_shares) s
CROSS JOIN (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(id), QUOTE(owner_user_id), QUOTE(code_hash), QUOTE(label), QUOTE(max_uses), QUOTE(used_count), QUOTE(expires_at), QUOTE(revoked_at), QUOTE(created_at))), 16), 16, 10) AS UNSIGNED)) h FROM acv_sharing.collection_shares) c

-- Les colonnes ajoutees (`collection_name`, `type_code`) sont controlees plus bas, contre les
-- catalogs, et non contre la source : c'est la qu'elles doivent concorder.
UNION ALL
SELECT 'verification', 'acv_sharing.collection_share_entries', s.n, c.n,
       IF(s.n <> c.n, 'KO', IF(s.h <> c.h, 'KO contenu', 'OK'))
FROM (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(share_id), QUOTE(collection_id), QUOTE(statuses))), 16), 16, 10) AS UNSIGNED)) h FROM acv_legacy.collection_share_entries) s
CROSS JOIN (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(share_id), QUOTE(collection_id), QUOTE(statuses))), 16), 16, 10) AS UNSIGNED)) h FROM acv_sharing.collection_share_entries) c

UNION ALL
SELECT 'verification', 'acv_sharing.collection_share_members', s.n, c.n,
       IF(s.n <> c.n, 'KO', IF(s.h <> c.h, 'KO contenu', 'OK'))
FROM (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(share_id), QUOTE(member_user_id), QUOTE(label), QUOTE(redeemed_at), QUOTE(revoked_at))), 16), 16, 10) AS UNSIGNED)) h FROM acv_legacy.collection_share_members) s
CROSS JOIN (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(share_id), QUOTE(member_user_id), QUOTE(label), QUOTE(redeemed_at), QUOTE(revoked_at))), 16), 16, 10) AS UNSIGNED)) h FROM acv_sharing.collection_share_members) c

UNION ALL
SELECT 'verification', 'acv_search.api_cache (edition-watch)', s.n, c.n,
       IF(s.n <> c.n, 'KO', IF(s.h <> c.h, 'KO contenu', 'OK'))
FROM (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(cache_key), QUOTE(payload), QUOTE(fetched_at), QUOTE(expires_at))), 16), 16, 10) AS UNSIGNED)) h FROM acv_legacy.api_cache WHERE cache_key LIKE 'edition-watch:%') s
CROSS JOIN (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(cache_key), QUOTE(payload), QUOTE(fetched_at), QUOTE(expires_at))), 16), 16, 10) AS UNSIGNED)) h FROM acv_search.api_cache WHERE cache_key LIKE 'edition-watch:%') c

-- ---------------------------------------------------------------------------- catalogs
-- Source filtree par type : un ecart ici dit aussi qu'une ligne est partie dans le mauvais
-- catalog.

UNION ALL
SELECT 'verification', 'acv_cat_manga.collections', s.n, c.n,
       IF(s.n <> c.n, 'KO', IF(s.h <> c.h, 'KO contenu', 'OK'))
FROM (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(c.id), QUOTE(c.user_id), QUOTE(t.code), QUOTE(c.name), QUOTE(c.description), QUOTE(c.item_count), QUOTE(c.created_at), QUOTE(c.updated_at))), 16), 16, 10) AS UNSIGNED)) h
      FROM acv_legacy.collections c JOIN acv_legacy.collection_types t ON t.id = c.type_id WHERE t.code = 'manga') s
CROSS JOIN (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(id), QUOTE(user_id), QUOTE(type_code), QUOTE(name), QUOTE(description), QUOTE(item_count), QUOTE(created_at), QUOTE(updated_at))), 16), 16, 10) AS UNSIGNED)) h FROM acv_cat_manga.collections) c

UNION ALL
SELECT 'verification', 'acv_cat_manga.collection_nodes', s.n, c.n,
       IF(s.n <> c.n, 'KO', IF(s.h <> c.h, 'KO contenu', 'OK'))
FROM (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(n.id), QUOTE(n.collection_id), QUOTE(n.user_id), QUOTE(n.parent_id), QUOTE(n.level), QUOTE(n.unified_data), QUOTE(n.sources), QUOTE(n.user_data), QUOTE(n.is_wishlist), QUOTE(n.created_at), QUOTE(n.updated_at))), 16), 16, 10) AS UNSIGNED)) h
      FROM acv_legacy.collection_nodes n JOIN acv_legacy.collections c ON c.id = n.collection_id JOIN acv_legacy.collection_types t ON t.id = c.type_id WHERE t.code = 'manga') s
CROSS JOIN (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(id), QUOTE(collection_id), QUOTE(user_id), QUOTE(parent_id), QUOTE(level), QUOTE(unified_data), QUOTE(sources), QUOTE(user_data), QUOTE(is_wishlist), QUOTE(created_at), QUOTE(updated_at))), 16), 16, 10) AS UNSIGNED)) h FROM acv_cat_manga.collection_nodes) c

UNION ALL
SELECT 'verification', 'acv_cat_manga.items', s.n, c.n,
       IF(s.n <> c.n, 'KO', IF(s.h <> c.h, 'KO contenu', 'OK'))
FROM (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(i.id), QUOTE(i.collection_id), QUOTE(i.user_id), QUOTE(i.node_id), QUOTE(i.volume), QUOTE(i.unified_data), QUOTE(i.sources), QUOTE(i.user_data), QUOTE(i.created_at), QUOTE(i.updated_at))), 16), 16, 10) AS UNSIGNED)) h
      FROM acv_legacy.items i JOIN acv_legacy.collections c ON c.id = i.collection_id JOIN acv_legacy.collection_types t ON t.id = c.type_id WHERE t.code = 'manga') s
CROSS JOIN (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(id), QUOTE(collection_id), QUOTE(user_id), QUOTE(node_id), QUOTE(volume), QUOTE(unified_data), QUOTE(sources), QUOTE(user_data), QUOTE(created_at), QUOTE(updated_at))), 16), 16, 10) AS UNSIGNED)) h FROM acv_cat_manga.items) c

UNION ALL
SELECT 'verification', 'acv_cat_vinyl.collections', s.n, c.n,
       IF(s.n <> c.n, 'KO', IF(s.h <> c.h, 'KO contenu', 'OK'))
FROM (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(c.id), QUOTE(c.user_id), QUOTE(t.code), QUOTE(c.name), QUOTE(c.description), QUOTE(c.item_count), QUOTE(c.created_at), QUOTE(c.updated_at))), 16), 16, 10) AS UNSIGNED)) h
      FROM acv_legacy.collections c JOIN acv_legacy.collection_types t ON t.id = c.type_id WHERE t.code = 'vinyl') s
CROSS JOIN (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(id), QUOTE(user_id), QUOTE(type_code), QUOTE(name), QUOTE(description), QUOTE(item_count), QUOTE(created_at), QUOTE(updated_at))), 16), 16, 10) AS UNSIGNED)) h FROM acv_cat_vinyl.collections) c

UNION ALL
SELECT 'verification', 'acv_cat_vinyl.collection_nodes', s.n, c.n,
       IF(s.n <> c.n, 'KO', IF(s.h <> c.h, 'KO contenu', 'OK'))
FROM (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(n.id), QUOTE(n.collection_id), QUOTE(n.user_id), QUOTE(n.parent_id), QUOTE(n.level), QUOTE(n.unified_data), QUOTE(n.sources), QUOTE(n.user_data), QUOTE(n.is_wishlist), QUOTE(n.created_at), QUOTE(n.updated_at))), 16), 16, 10) AS UNSIGNED)) h
      FROM acv_legacy.collection_nodes n JOIN acv_legacy.collections c ON c.id = n.collection_id JOIN acv_legacy.collection_types t ON t.id = c.type_id WHERE t.code = 'vinyl') s
CROSS JOIN (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(id), QUOTE(collection_id), QUOTE(user_id), QUOTE(parent_id), QUOTE(level), QUOTE(unified_data), QUOTE(sources), QUOTE(user_data), QUOTE(is_wishlist), QUOTE(created_at), QUOTE(updated_at))), 16), 16, 10) AS UNSIGNED)) h FROM acv_cat_vinyl.collection_nodes) c

UNION ALL
SELECT 'verification', 'acv_cat_vinyl.items', s.n, c.n,
       IF(s.n <> c.n, 'KO', IF(s.h <> c.h, 'KO contenu', 'OK'))
FROM (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(i.id), QUOTE(i.collection_id), QUOTE(i.user_id), QUOTE(i.node_id), QUOTE(i.volume), QUOTE(i.unified_data), QUOTE(i.sources), QUOTE(i.user_data), QUOTE(i.created_at), QUOTE(i.updated_at))), 16), 16, 10) AS UNSIGNED)) h
      FROM acv_legacy.items i JOIN acv_legacy.collections c ON c.id = i.collection_id JOIN acv_legacy.collection_types t ON t.id = c.type_id WHERE t.code = 'vinyl') s
CROSS JOIN (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(id), QUOTE(collection_id), QUOTE(user_id), QUOTE(node_id), QUOTE(volume), QUOTE(unified_data), QUOTE(sources), QUOTE(user_data), QUOTE(created_at), QUOTE(updated_at))), 16), 16, 10) AS UNSIGNED)) h FROM acv_cat_vinyl.items) c

UNION ALL
SELECT 'verification', 'acv_cat_generic.collections', s.n, c.n,
       IF(s.n <> c.n, 'KO', IF(s.h <> c.h, 'KO contenu', 'OK'))
FROM (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(c.id), QUOTE(c.user_id), QUOTE(t.code), QUOTE(c.name), QUOTE(c.description), QUOTE(c.item_count), QUOTE(c.created_at), QUOTE(c.updated_at))), 16), 16, 10) AS UNSIGNED)) h
      FROM acv_legacy.collections c JOIN acv_legacy.collection_types t ON t.id = c.type_id WHERE t.code IN ('movie', 'book', 'game')) s
CROSS JOIN (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(id), QUOTE(user_id), QUOTE(type_code), QUOTE(name), QUOTE(description), QUOTE(item_count), QUOTE(created_at), QUOTE(updated_at))), 16), 16, 10) AS UNSIGNED)) h FROM acv_cat_generic.collections) c

UNION ALL
SELECT 'verification', 'acv_cat_generic.collection_nodes', s.n, c.n,
       IF(s.n <> c.n, 'KO', IF(s.h <> c.h, 'KO contenu', 'OK'))
FROM (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(n.id), QUOTE(n.collection_id), QUOTE(n.user_id), QUOTE(n.parent_id), QUOTE(n.level), QUOTE(n.unified_data), QUOTE(n.sources), QUOTE(n.user_data), QUOTE(n.is_wishlist), QUOTE(n.created_at), QUOTE(n.updated_at))), 16), 16, 10) AS UNSIGNED)) h
      FROM acv_legacy.collection_nodes n JOIN acv_legacy.collections c ON c.id = n.collection_id JOIN acv_legacy.collection_types t ON t.id = c.type_id WHERE t.code IN ('movie', 'book', 'game')) s
CROSS JOIN (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(id), QUOTE(collection_id), QUOTE(user_id), QUOTE(parent_id), QUOTE(level), QUOTE(unified_data), QUOTE(sources), QUOTE(user_data), QUOTE(is_wishlist), QUOTE(created_at), QUOTE(updated_at))), 16), 16, 10) AS UNSIGNED)) h FROM acv_cat_generic.collection_nodes) c

UNION ALL
SELECT 'verification', 'acv_cat_generic.items', s.n, c.n,
       IF(s.n <> c.n, 'KO', IF(s.h <> c.h, 'KO contenu', 'OK'))
FROM (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(i.id), QUOTE(i.collection_id), QUOTE(i.user_id), QUOTE(i.node_id), QUOTE(i.volume), QUOTE(i.unified_data), QUOTE(i.sources), QUOTE(i.user_data), QUOTE(i.created_at), QUOTE(i.updated_at))), 16), 16, 10) AS UNSIGNED)) h
      FROM acv_legacy.items i JOIN acv_legacy.collections c ON c.id = i.collection_id JOIN acv_legacy.collection_types t ON t.id = c.type_id WHERE t.code IN ('movie', 'book', 'game')) s
CROSS JOIN (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(id), QUOTE(collection_id), QUOTE(user_id), QUOTE(node_id), QUOTE(volume), QUOTE(unified_data), QUOTE(sources), QUOTE(user_data), QUOTE(created_at), QUOTE(updated_at))), 16), 16, 10) AS UNSIGNED)) h FROM acv_cat_generic.items) c

-- ------------------------------------------------------------------------------ gateway

UNION ALL
SELECT 'verification', 'acv_gateway.collection_registry', s.n, c.n,
       IF(s.n <> c.n, 'KO', IF(s.h <> c.h, 'KO contenu', 'OK'))
FROM (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(c.id), QUOTE(c.user_id), QUOTE(t.code))), 16), 16, 10) AS UNSIGNED)) h
      FROM acv_legacy.collections c JOIN acv_legacy.collection_types t ON t.id = c.type_id) s
CROSS JOIN (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(collection_id), QUOTE(user_id), QUOTE(type_code))), 16), 16, 10) AS UNSIGNED)) h FROM acv_gateway.collection_registry) c

UNION ALL
SELECT 'verification', 'acv_gateway.resource_registry', s.n, c.n,
       IF(s.n <> c.n, 'KO', IF(s.h <> c.h, 'KO contenu', 'OK'))
FROM (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(id), QUOTE(kind), QUOTE(collection_id))), 16), 16, 10) AS UNSIGNED)) h
      FROM (SELECT id, 'item' AS kind, collection_id FROM acv_legacy.items
            UNION ALL
            SELECT id, 'node', collection_id FROM acv_legacy.collection_nodes) r) s
CROSS JOIN (SELECT COUNT(*) n, BIT_XOR(CAST(CONV(LEFT(SHA1(CONCAT_WS(',', QUOTE(resource_id), QUOTE(kind), QUOTE(collection_id))), 16), 16, 10) AS UNSIGNED)) h FROM acv_gateway.resource_registry) c

-- ---------------------------------------------------------------------------- invariants

-- Chaque collection du monolithe est dans un catalog, et un seul.
UNION ALL
SELECT 'invariant', 'collections, tous catalogs confondus',
       (SELECT COUNT(*) FROM acv_legacy.collections),
       (SELECT COUNT(*) FROM (SELECT id FROM acv_cat_manga.collections
                              UNION SELECT id FROM acv_cat_vinyl.collections
                              UNION SELECT id FROM acv_cat_generic.collections) u),
       IF((SELECT COUNT(*) FROM acv_legacy.collections)
          = (SELECT COUNT(*) FROM (SELECT id FROM acv_cat_manga.collections
                                   UNION SELECT id FROM acv_cat_vinyl.collections
                                   UNION SELECT id FROM acv_cat_generic.collections) u),
          'OK', 'KO')

-- Le registre envoie chaque collection vers le catalog qui la detient : c'est la condition
-- pour qu'aucune ressource existante ne reponde 404 (3.3 de l'architecture).
UNION ALL
SELECT 'invariant', 'registre pointant hors du bon catalog', '0', COUNT(*),
       IF(COUNT(*) = 0, 'OK', 'KO')
FROM acv_gateway.collection_registry r
WHERE NOT (
     (r.type_code = 'manga' AND EXISTS (SELECT 1 FROM acv_cat_manga.collections c WHERE c.id = r.collection_id AND c.user_id = r.user_id))
  OR (r.type_code = 'vinyl' AND EXISTS (SELECT 1 FROM acv_cat_vinyl.collections c WHERE c.id = r.collection_id AND c.user_id = r.user_id))
  OR (r.type_code IN ('movie', 'book', 'game') AND EXISTS (SELECT 1 FROM acv_cat_generic.collections c WHERE c.id = r.collection_id AND c.user_id = r.user_id AND c.type_code = r.type_code))
)

-- Les copies de `sharing` concordent avec les catalogs : un nom ou un type faux s'afficherait
-- tel quel chez le membre, que rien ne viendrait corriger.
UNION ALL
SELECT 'invariant', 'entrees de partage sans collection conforme', '0', COUNT(*),
       IF(COUNT(*) = 0, 'OK', 'KO')
FROM acv_sharing.collection_share_entries e
WHERE NOT EXISTS (
  SELECT 1 FROM (SELECT id, name, type_code FROM acv_cat_manga.collections
                 UNION ALL SELECT id, name, type_code FROM acv_cat_vinyl.collections
                 UNION ALL SELECT id, name, type_code FROM acv_cat_generic.collections) c
  WHERE c.id = e.collection_id AND c.name = e.collection_name AND c.type_code = e.type_code
)

-- Aucun `userId` orphelin. Le monolithe le garantissait par ses FK vers `users` ; separees en
-- schemas, les tables ne le garantissent plus que si la reprise n'a rien perdu. Hors
-- `audit_logs`, dont `user_id` n'a jamais ete une FK.
UNION ALL
SELECT 'invariant', 'userId orphelins dans les catalogs', '0', COUNT(*),
       IF(COUNT(*) = 0, 'OK', 'KO')
FROM (SELECT user_id FROM acv_cat_manga.collections UNION ALL SELECT user_id FROM acv_cat_manga.collection_nodes UNION ALL SELECT user_id FROM acv_cat_manga.items
      UNION ALL SELECT user_id FROM acv_cat_vinyl.collections UNION ALL SELECT user_id FROM acv_cat_vinyl.collection_nodes UNION ALL SELECT user_id FROM acv_cat_vinyl.items
      UNION ALL SELECT user_id FROM acv_cat_generic.collections UNION ALL SELECT user_id FROM acv_cat_generic.collection_nodes UNION ALL SELECT user_id FROM acv_cat_generic.items) x
WHERE NOT EXISTS (SELECT 1 FROM acv_core.users u WHERE u.id = x.user_id)

UNION ALL
SELECT 'invariant', 'userId orphelins dans billing, connections, sharing', '0', COUNT(*),
       IF(COUNT(*) = 0, 'OK', 'KO')
FROM (SELECT user_id FROM acv_billing.subscriptions
      UNION ALL SELECT user_id FROM acv_billing.premium_grants
      UNION ALL SELECT user_id FROM acv_billing.invitation_redemptions
      UNION ALL SELECT user_id FROM acv_conn.oauth_credentials
      UNION ALL SELECT owner_user_id FROM acv_sharing.collection_shares
      UNION ALL SELECT member_user_id FROM acv_sharing.collection_share_members) x
WHERE NOT EXISTS (SELECT 1 FROM acv_core.users u WHERE u.id = x.user_id)

-- Constat seulement : `item_count` est copie tel quel. Un ecart vient du monolithe, la reprise
-- ne le corrige pas - le corriger ici changerait des donnees sous couvert de les deplacer.
UNION ALL
SELECT 'constat', 'item_count different du nombre reel d items', '-', COUNT(*),
       IF(COUNT(*) = 0, 'OK', 'INFO')
FROM acv_legacy.collections c
WHERE c.item_count <> (SELECT COUNT(*) FROM acv_legacy.items i WHERE i.collection_id = c.id);
