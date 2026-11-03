-- Preconditions de la reprise : rien n'est ecrit tant que l'une d'elles est KO.
--
-- Chaque ligne du rapport : etape, objet, attendu, observe, statut (OK | KO). `reprise.sh`
-- echoue des qu'une ligne est KO.

-- 1. Le monolithe est exactement a la version que 10-transform.sql connait. Une migration
--    inconnue peut avoir ajoute une colonne que la reprise ignorerait sans rien dire : c'est
--    la perte de donnees silencieuse que ce controle interdit. Ajouter une migration au
--    monolithe impose donc de relire 10-transform.sql et de completer cette liste.
SELECT 'precondition', 'migrations du monolithe connues', '8', COUNT(*),
       IF(COUNT(*) = 8, 'OK', 'KO')
FROM acv_legacy._prisma_migrations
WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
  AND migration_name IN (
    '20260524151135_init',
    '20260526203431_add_audit_logs',
    '20260529151631_collections_multi_provider',
    '20260609215819_add_item_user_data',
    '20260708120000_drop_rate_limit_buckets',
    '20260821182330_add_collection_shares',
    '20260822114550_shares_multi_collections_statuses',
    '20260822114900_purge_pre_s5_shares'
  )
UNION ALL
SELECT 'precondition', 'migrations du monolithe inconnues ou inachevees', '0', COUNT(*),
       IF(COUNT(*) = 0, 'OK', 'KO')
FROM acv_legacy._prisma_migrations
WHERE rolled_back_at IS NULL
  AND (finished_at IS NULL OR migration_name NOT IN (
    '20260524151135_init',
    '20260526203431_add_audit_logs',
    '20260529151631_collections_multi_provider',
    '20260609215819_add_item_user_data',
    '20260708120000_drop_rate_limit_buckets',
    '20260821182330_add_collection_shares',
    '20260822114550_shares_multi_collections_statuses',
    '20260822114900_purge_pre_s5_shares'
  ))

-- 2. Chaque collection a un catalog pour la recevoir. La liste est `CATALOG_BY_TYPE`
--    (gateway/src/routing/service-registry.service.ts) : une collection d'un autre type ne
--    serait copiee nulle part.
UNION ALL
SELECT 'precondition', 'collections d un type sans catalog', '0', COUNT(*),
       IF(COUNT(*) = 0, 'OK', 'KO')
FROM acv_legacy.collections c
JOIN acv_legacy.collection_types t ON t.id = c.type_id
WHERE t.code NOT IN ('manga', 'vinyl', 'movie', 'book', 'game')
UNION ALL
SELECT 'precondition', 'types absents de acv_core.collection_types', '0', COUNT(*),
       IF(COUNT(*) = 0, 'OK', 'KO')
FROM (SELECT DISTINCT t.code
      FROM acv_legacy.collections c
      JOIN acv_legacy.collection_types t ON t.id = c.type_id) used
LEFT JOIN acv_core.collection_types ct ON ct.code = used.code
WHERE ct.id IS NULL

-- 3. Les tables cibles sont vides. La reprise n'est pas une fusion : une ligne deja presente
--    vient d'un essai precedent (`reprise.sh reset-targets`) ou, pire, d'un utilisateur reel,
--    et dans les deux cas la decision n'appartient pas au script.
--    `acv_core.collection_types` n'y figure pas : la migration d'identity la remplit, et plus
--    aucune table n'y fait reference (les catalogs stockent le code en clair).
UNION ALL SELECT 'precondition', 'acv_core.users vide', '0', COUNT(*), IF(COUNT(*) = 0, 'OK', 'KO') FROM acv_core.users
UNION ALL SELECT 'precondition', 'acv_core.audit_logs vide', '0', COUNT(*), IF(COUNT(*) = 0, 'OK', 'KO') FROM acv_core.audit_logs
UNION ALL SELECT 'precondition', 'acv_core.user_deletion_jobs vide', '0', COUNT(*), IF(COUNT(*) = 0, 'OK', 'KO') FROM acv_core.user_deletion_jobs
UNION ALL SELECT 'precondition', 'acv_billing.subscriptions vide', '0', COUNT(*), IF(COUNT(*) = 0, 'OK', 'KO') FROM acv_billing.subscriptions
UNION ALL SELECT 'precondition', 'acv_billing.premium_grants vide', '0', COUNT(*), IF(COUNT(*) = 0, 'OK', 'KO') FROM acv_billing.premium_grants
UNION ALL SELECT 'precondition', 'acv_billing.invitations vide', '0', COUNT(*), IF(COUNT(*) = 0, 'OK', 'KO') FROM acv_billing.invitations
UNION ALL SELECT 'precondition', 'acv_billing.invitation_redemptions vide', '0', COUNT(*), IF(COUNT(*) = 0, 'OK', 'KO') FROM acv_billing.invitation_redemptions
UNION ALL SELECT 'precondition', 'acv_conn.oauth_credentials vide', '0', COUNT(*), IF(COUNT(*) = 0, 'OK', 'KO') FROM acv_conn.oauth_credentials
UNION ALL SELECT 'precondition', 'acv_sharing.collection_shares vide', '0', COUNT(*), IF(COUNT(*) = 0, 'OK', 'KO') FROM acv_sharing.collection_shares
UNION ALL SELECT 'precondition', 'acv_sharing.collection_share_entries vide', '0', COUNT(*), IF(COUNT(*) = 0, 'OK', 'KO') FROM acv_sharing.collection_share_entries
UNION ALL SELECT 'precondition', 'acv_sharing.collection_share_members vide', '0', COUNT(*), IF(COUNT(*) = 0, 'OK', 'KO') FROM acv_sharing.collection_share_members
-- Le reste du cache de `search` peut se remplir des le demarrage : seule la famille reprise
-- doit etre absente.
UNION ALL SELECT 'precondition', 'acv_search.api_cache sans edition-watch', '0', COUNT(*), IF(COUNT(*) = 0, 'OK', 'KO') FROM acv_search.api_cache WHERE cache_key LIKE 'edition-watch:%'
UNION ALL SELECT 'precondition', 'acv_cat_manga.collections vide', '0', COUNT(*), IF(COUNT(*) = 0, 'OK', 'KO') FROM acv_cat_manga.collections
UNION ALL SELECT 'precondition', 'acv_cat_manga.collection_nodes vide', '0', COUNT(*), IF(COUNT(*) = 0, 'OK', 'KO') FROM acv_cat_manga.collection_nodes
UNION ALL SELECT 'precondition', 'acv_cat_manga.items vide', '0', COUNT(*), IF(COUNT(*) = 0, 'OK', 'KO') FROM acv_cat_manga.items
UNION ALL SELECT 'precondition', 'acv_cat_vinyl.collections vide', '0', COUNT(*), IF(COUNT(*) = 0, 'OK', 'KO') FROM acv_cat_vinyl.collections
UNION ALL SELECT 'precondition', 'acv_cat_vinyl.collection_nodes vide', '0', COUNT(*), IF(COUNT(*) = 0, 'OK', 'KO') FROM acv_cat_vinyl.collection_nodes
UNION ALL SELECT 'precondition', 'acv_cat_vinyl.items vide', '0', COUNT(*), IF(COUNT(*) = 0, 'OK', 'KO') FROM acv_cat_vinyl.items
UNION ALL SELECT 'precondition', 'acv_cat_generic.collections vide', '0', COUNT(*), IF(COUNT(*) = 0, 'OK', 'KO') FROM acv_cat_generic.collections
UNION ALL SELECT 'precondition', 'acv_cat_generic.collection_nodes vide', '0', COUNT(*), IF(COUNT(*) = 0, 'OK', 'KO') FROM acv_cat_generic.collection_nodes
UNION ALL SELECT 'precondition', 'acv_cat_generic.items vide', '0', COUNT(*), IF(COUNT(*) = 0, 'OK', 'KO') FROM acv_cat_generic.items
UNION ALL SELECT 'precondition', 'acv_gateway.collection_registry vide', '0', COUNT(*), IF(COUNT(*) = 0, 'OK', 'KO') FROM acv_gateway.collection_registry
UNION ALL SELECT 'precondition', 'acv_gateway.resource_registry vide', '0', COUNT(*), IF(COUNT(*) = 0, 'OK', 'KO') FROM acv_gateway.resource_registry;
