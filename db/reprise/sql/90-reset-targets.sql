-- Vide les tables que la reprise remplit, et elles seules. Joue par
-- `reprise.sh reset-targets`, qui exige CONFIRM_RESET=yes.
--
-- Usage legitime : entre deux repetitions, ou apres une reprise dont le controle est KO.
-- **Jamais une fois le reverse proxy bascule** : a partir de la, ces tables contiennent des
-- ecritures d'utilisateurs que rien ne permet de reconstituer.
--
-- Ne touche ni `collection_types` (remplie par la migration d'identity), ni le reste du cache
-- de `search`, ni les journaux de reconstruction du registre, ni les schemas LEGO.
-- DELETE plutot que TRUNCATE : transactionnel, et sans couper les FK.

START TRANSACTION;

DELETE FROM acv_core.users;
DELETE FROM acv_core.audit_logs;
DELETE FROM acv_core.user_deletion_jobs;

DELETE FROM acv_billing.invitation_redemptions;
DELETE FROM acv_billing.invitations;
DELETE FROM acv_billing.premium_grants;
DELETE FROM acv_billing.subscriptions;

DELETE FROM acv_conn.oauth_credentials;

DELETE FROM acv_sharing.collection_share_members;
DELETE FROM acv_sharing.collection_share_entries;
DELETE FROM acv_sharing.collection_shares;

DELETE FROM acv_search.api_cache WHERE cache_key LIKE 'edition-watch:%';

-- Items, puis noeuds, puis collections : l'ordre des FK internes a chaque catalog. La FK
-- `parent_id` des noeuds est en cascade, un seul DELETE suffit pour toute la hierarchie.
DELETE FROM acv_cat_manga.items;
DELETE FROM acv_cat_manga.collection_nodes;
DELETE FROM acv_cat_manga.collections;
DELETE FROM acv_cat_vinyl.items;
DELETE FROM acv_cat_vinyl.collection_nodes;
DELETE FROM acv_cat_vinyl.collections;
DELETE FROM acv_cat_generic.items;
DELETE FROM acv_cat_generic.collection_nodes;
DELETE FROM acv_cat_generic.collections;

DELETE FROM acv_gateway.resource_registry;
DELETE FROM acv_gateway.collection_registry;

COMMIT;
