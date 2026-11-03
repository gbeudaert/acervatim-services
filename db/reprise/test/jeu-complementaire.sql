-- Jeu de donnees complementaire pour REPETER la reprise - jamais pour la vraie bascule.
--
-- Charge dans `acv_legacy` apres le vidage du monolithe (`reprise.sh load`), il couvre ce que
-- des donnees de developpement n'ont souvent pas : les cinq types de collection, une
-- hierarchie de noeuds, des partages a plusieurs collections avec un membre revoque, des
-- jetons OAuth, un abonnement, du texte sur 4 octets (emoji), des echappements JSON, des dates
-- a la milliseconde, un `item_count` faux, et du cache repris ou non.
--
-- Identifiants en `7e570000-...` : ils ne peuvent pas rencontrer ceux, aleatoires, du vidage.
--
--   U1 7e570000-...0001  proprietaire : 6 collections (5 types), 2 partages, abonnement actif,
--                        Discogs et MAL lies
--   U2 7e570000-...0002  membre actif du partage S1, premium par attribution, une collection manga
--   U3 7e570000-...0003  membre revoque du partage S1

INSERT INTO acv_legacy.users (id, google_sub_hash, created_at, updated_at) VALUES
  ('7e570000-0000-4000-8000-000000000001', '7e57000000000000000000000000000000000000000000000000000000000001', '2026-03-14 15:09:26.535', '2026-10-01 08:00:00.001'),
  ('7e570000-0000-4000-8000-000000000002', '7e57000000000000000000000000000000000000000000000000000000000002', '2026-04-01 10:00:00.000', '2026-04-01 10:00:00.000'),
  ('7e570000-0000-4000-8000-000000000003', '7e57000000000000000000000000000000000000000000000000000000000003', '2026-05-02 11:22:33.444', '2026-05-02 11:22:33.444');

INSERT INTO acv_legacy.collections (id, user_id, type_id, name, description, item_count, created_at, updated_at)
SELECT v.id, v.user_id, t.id, v.name, v.description, v.item_count, v.created_at, v.updated_at
FROM (
  SELECT '7e570000-0000-4000-8000-000000000c01' AS id, '7e570000-0000-4000-8000-000000000001' AS user_id, 'manga' AS code,
         'Mangas d''Ünïcødé 🎌 « guillemets » "doubles" \\ antislash' AS name, NULL AS description, 3 AS item_count,
         '2026-03-14 15:10:00.123' AS created_at, '2026-10-02 09:00:00.999' AS updated_at
  UNION ALL SELECT '7e570000-0000-4000-8000-000000000c02', '7e570000-0000-4000-8000-000000000001', 'vinyl', 'Vinyles', REPEAT('Description longue. ', 400), 2, '2026-03-15 10:00:00.000', '2026-03-15 10:00:00.000'
  UNION ALL SELECT '7e570000-0000-4000-8000-000000000c03', '7e570000-0000-4000-8000-000000000001', 'movie', 'Films', '', 1, '2026-03-16 10:00:00.000', '2026-03-16 10:00:00.000'
  -- item_count volontairement faux (0 pour 1 item) : doit sortir en INFO, recopie tel quel.
  UNION ALL SELECT '7e570000-0000-4000-8000-000000000c04', '7e570000-0000-4000-8000-000000000001', 'book', 'Livres', NULL, 0, '2026-03-17 10:00:00.000', '2026-03-17 10:00:00.000'
  UNION ALL SELECT '7e570000-0000-4000-8000-000000000c05', '7e570000-0000-4000-8000-000000000001', 'game', 'Jeux', NULL, 0, '2026-03-18 10:00:00.000', '2026-03-18 10:00:00.000'
  UNION ALL SELECT '7e570000-0000-4000-8000-000000000c06', '7e570000-0000-4000-8000-000000000002', 'manga', 'Mangas de Bob', NULL, 1, '2026-04-01 10:05:00.000', '2026-04-01 10:05:00.000'
  UNION ALL SELECT '7e570000-0000-4000-8000-000000000c07', '7e570000-0000-4000-8000-000000000001', 'manga', 'Mangas vide', NULL, 0, '2026-03-19 10:00:00.000', '2026-03-19 10:00:00.000'
) v
JOIN acv_legacy.collection_types t ON t.code = v.code;

-- L'enfant (0d01) a un identifiant INFERIEUR a son parent (0d02) : une copie dans l'ordre des
-- cles primaires l'insererait avant lui et la FK `parent_id` la refuserait. C'est ce que le
-- tri par profondeur de 10-transform.sql doit eviter.
INSERT INTO acv_legacy.collection_nodes (id, collection_id, user_id, parent_id, level, unified_data, sources, user_data, is_wishlist, created_at, updated_at) VALUES
  ('7e570000-0000-4000-8000-000000000d02', '7e570000-0000-4000-8000-000000000c01', '7e570000-0000-4000-8000-000000000001', NULL, 'serie',
   '{"title":"Saga de reprise","publisherFr":"Glénat","edition":null,"mangaId":"0f3b0d4e-0000-4000-8000-000000000001","status":"ongoing"}',
   '[{"provider":"mal","externalId":"4242","rawData":{"title":"Saga"},"fetchedAt":"2026-03-14T15:10:00.000Z"}]',
   '{"note":"Ligne 1\\nLigne 2 \\"citee\\" 🎌"}', 0, '2026-03-14 15:11:00.321', '2026-03-14 15:11:00.321'),
  ('7e570000-0000-4000-8000-000000000d01', '7e570000-0000-4000-8000-000000000c01', '7e570000-0000-4000-8000-000000000001', '7e570000-0000-4000-8000-000000000d02', 'set',
   '{"title":"Coffret de reprise"}', '[]', '{}', 1, '2026-03-14 15:12:00.000', '2026-03-14 15:12:00.000'),
  ('7e570000-0000-4000-8000-000000000d03', '7e570000-0000-4000-8000-000000000c06', '7e570000-0000-4000-8000-000000000002', NULL, 'serie',
   '{"title":"Saga de reprise","publisherFr":"Glénat","edition":null,"mangaId":null,"status":"ongoing"}', '[]', '{}', 0, '2026-04-01 10:06:00.000', '2026-04-01 10:06:00.000');

INSERT INTO acv_legacy.items (id, collection_id, user_id, node_id, volume, unified_data, sources, user_data, created_at, updated_at) VALUES
  ('7e570000-0000-4000-8000-000000000e01', '7e570000-0000-4000-8000-000000000c01', '7e570000-0000-4000-8000-000000000001', '7e570000-0000-4000-8000-000000000d02', 1,
   '{"title":"Saga de reprise T01","isbn":"9782344000001"}', '[]', '{"status":"OWNED"}', '2026-03-14 15:13:00.001', '2026-03-14 15:13:00.001'),
  ('7e570000-0000-4000-8000-000000000e02', '7e570000-0000-4000-8000-000000000c01', '7e570000-0000-4000-8000-000000000001', '7e570000-0000-4000-8000-000000000d02', 2,
   '{"title":"Saga de reprise T02","isbn":"9782344000002"}', '[]', '{"status":"WISHLIST"}', '2026-03-14 15:13:00.002', '2026-03-14 15:13:00.002'),
  ('7e570000-0000-4000-8000-000000000e03', '7e570000-0000-4000-8000-000000000c01', '7e570000-0000-4000-8000-000000000001', '7e570000-0000-4000-8000-000000000d02', 3,
   '{"title":"Saga de reprise T03","isbn":"9782344000003"}',
   '[{"provider":"bnf","externalId":"cb000000003","rawData":{"200$a":"Saga de reprise"},"fetchedAt":"2026-03-14T15:13:00.000Z"}]',
   '{"status":"OWNED","rating":4.5,"price":{"amount":7.2,"currency":"EUR"}}', '2026-03-14 15:13:00.003', '2026-06-01 12:00:00.000'),
  -- Deux vinyles du meme utilisateur sans noeud ni volume : (user, NULL, NULL) n'est pas
  -- deduplique par l'index unique, comme dans le monolithe. Le statut se lit dans
  -- `user_data.status` ; absent (film, livre), il vaut OWNED.
  ('7e570000-0000-4000-8000-000000000e04', '7e570000-0000-4000-8000-000000000c02', '7e570000-0000-4000-8000-000000000001', NULL, NULL,
   '{"title":"Kind of Blue","artist":"Miles Davis"}', '[]', '{"status":"OWNED"}', '2026-03-15 10:01:00.000', '2026-03-15 10:01:00.000'),
  ('7e570000-0000-4000-8000-000000000e08', '7e570000-0000-4000-8000-000000000c02', '7e570000-0000-4000-8000-000000000001', NULL, NULL,
   '{"title":"Björk — Homogenic"}', '[]', '{"status":"WISHLIST"}', '2026-03-15 10:02:00.000', '2026-03-15 10:02:00.000'),
  ('7e570000-0000-4000-8000-000000000e05', '7e570000-0000-4000-8000-000000000c03', '7e570000-0000-4000-8000-000000000001', NULL, NULL,
   '{"title":"Le Voyage de Chihiro"}', '[]', '{}', '2026-03-16 10:01:00.000', '2026-03-16 10:01:00.000'),
  ('7e570000-0000-4000-8000-000000000e06', '7e570000-0000-4000-8000-000000000c04', '7e570000-0000-4000-8000-000000000001', NULL, NULL,
   '{"title":"Les Misérables"}', '[]', '{}', '2026-03-17 10:01:00.000', '2026-03-17 10:01:00.000'),
  ('7e570000-0000-4000-8000-000000000e07', '7e570000-0000-4000-8000-000000000c06', '7e570000-0000-4000-8000-000000000002', '7e570000-0000-4000-8000-000000000d03', 1,
   '{"title":"Saga de reprise T01"}', '[]', '{"status":"OWNED"}', '2026-04-01 10:07:00.000', '2026-04-01 10:07:00.000');

INSERT INTO acv_legacy.subscriptions (user_id, status, product_id, purchase_token, expires_at, auto_renew, started_at, last_verified_at, cancel_reason) VALUES
  ('7e570000-0000-4000-8000-000000000001', 'active', 'acervatim_premium_monthly', CONCAT('reprise-fixture-', REPEAT('t', 400)), 1893456000000, 1,
   '2026-03-20 08:00:00.000', '2026-10-30 08:00:00.000', NULL);

INSERT INTO acv_legacy.premium_grants (user_id, reason, granted_by, granted_at, expires_at, notes) VALUES
  ('7e570000-0000-4000-8000-000000000002', 'beta_tester', 'admin', '2026-04-01 10:00:01.000', NULL, 'Bêta-testeur — accès offert');

INSERT INTO acv_legacy.invitations (code_hash, reason, grants_premium, premium_expires_at, max_uses, used_count, expires_at, created_by, notes, created_at) VALUES
  ('7e570000000000000000000000000000000000000000000000000000000000a1', 'beta_tester', 1, NULL, 5, 1, 1924992000000, 'admin', 'Vague de bêta n°1', '2026-03-30 09:00:00.000'),
  ('7e570000000000000000000000000000000000000000000000000000000000a2', 'comp', 0, NULL, 1, 0, NULL, NULL, NULL, '2026-03-31 09:00:00.000');

INSERT INTO acv_legacy.invitation_redemptions (invitation_code_hash, user_id, redeemed_at) VALUES
  ('7e570000000000000000000000000000000000000000000000000000000000a1', '7e570000-0000-4000-8000-000000000002', '2026-04-01 10:00:00.500');

INSERT INTO acv_legacy.oauth_credentials (user_id, provider, access_token_encrypted, refresh_token_encrypted, expires_at, scopes, encrypted_with_key_version, updated_at) VALUES
  ('7e570000-0000-4000-8000-000000000001', 'discogs', 'v1:reprise-fixture:access-discogs', 'v1:reprise-fixture:secret-discogs', 0, '[]', 1, '2026-03-21 08:00:00.000'),
  ('7e570000-0000-4000-8000-000000000001', 'mal', 'v1:reprise-fixture:access-mal', NULL, 1798761600000, '["read"]', 1, '2026-03-22 08:00:00.000');

INSERT INTO acv_legacy.collection_shares (id, owner_user_id, code_hash, label, max_uses, used_count, expires_at, revoked_at, created_at) VALUES
  ('7e570000-0000-4000-8000-000000000501', '7e570000-0000-4000-8000-000000000001', '7e570000000000000000000000000000000000000000000000000000000000b1', 'Wantlist manga avec Alice', 3, 2, NULL, NULL, '2026-04-01 09:59:00.000'),
  ('7e570000-0000-4000-8000-000000000502', '7e570000-0000-4000-8000-000000000001', '7e570000000000000000000000000000000000000000000000000000000000b2', NULL, 1, 0, 1798761600000, '2026-05-01 00:00:00.000', '2026-04-15 09:00:00.000');

INSERT INTO acv_legacy.collection_share_entries (share_id, collection_id, statuses) VALUES
  ('7e570000-0000-4000-8000-000000000501', '7e570000-0000-4000-8000-000000000c01', '["OWNED","WISHLIST"]'),
  ('7e570000-0000-4000-8000-000000000501', '7e570000-0000-4000-8000-000000000c02', '["WISHLIST"]'),
  ('7e570000-0000-4000-8000-000000000502', '7e570000-0000-4000-8000-000000000c03', '["OWNED"]');

INSERT INTO acv_legacy.collection_share_members (share_id, member_user_id, label, redeemed_at, revoked_at) VALUES
  ('7e570000-0000-4000-8000-000000000501', '7e570000-0000-4000-8000-000000000002', 'Wantlist de Bob', '2026-04-01 10:00:02.000', NULL),
  ('7e570000-0000-4000-8000-000000000501', '7e570000-0000-4000-8000-000000000003', NULL, '2026-05-02 11:30:00.000', '2026-05-10 00:00:00.000');

INSERT INTO acv_legacy.audit_logs (id, user_id, action, target, metadata, created_at) VALUES
  ('7e570000-0000-4000-8000-000000000a01', '7e570000-0000-4000-8000-000000000001', 'share.create', '7e570000-0000-4000-8000-000000000501', '{"collections":2,"note":"é 🎌"}', '2026-04-01 09:59:00.001'),
  ('7e570000-0000-4000-8000-000000000a02', NULL, 'auth.login_failed', NULL, NULL, '2026-04-02 00:00:00.000');

-- Cache : l'etat de rattrapage de « Saga de reprise » chez Glenat, edition standard. La cle
-- est `editionWatchKey('Saga de reprise', 'Glénat', null)`
-- (search/src/search/watch/edition-watch.types.ts), calculee dans le conteneur `search`.
-- U1 possede les tomes 1 a 3 : `GET /v1/series-updates` doit lui proposer le tome 4, ce qui
-- prouve a la fois l'abonnement, les noeuds du catalog et l'etat du cache repris.
INSERT INTO acv_legacy.api_cache (cache_key, payload, fetched_at, expires_at) VALUES
  ('edition-watch:v1:69224cb0174c829e0b5dd7d7d3ac8d042cad8236',
   '{"title":"Saga de reprise","publisherFr":"Glénat","edition":null,"lastCheckedAt":"2026-10-28T03:00:00.000Z","retrySince":null,"tomes":[{"isbn":"9782344000003","editionVolume":3,"titleFr":"Saga de reprise T03","noticeCreatedAt":"2026-09-01","coverUrl":null,"detectedAt":"2026-09-08T03:00:00.000Z"},{"isbn":"9782344000004","editionVolume":4,"titleFr":"Saga de reprise T04","noticeCreatedAt":"2026-10-20","coverUrl":null,"detectedAt":"2026-10-27T03:00:00.000Z"}]}',
   '2026-10-28 03:00:00.000', '2027-04-26 03:00:00.000'),
  -- Expire : repris quand meme (10-transform.sql explique pourquoi), ignore a la lecture.
  ('edition-watch:v1:000000000000000000000000000000000000dead',
   '{"title":"Ancienne serie","publisherFr":"Pika","edition":null,"lastCheckedAt":null,"tomes":[]}',
   '2025-06-01 03:00:00.000', '2025-11-28 03:00:00.000'),
  -- Hors famille reprise : ne doit pas arriver dans acv_search.
  ('bnf:sru:reprise-fixture', '{"records":[]}', '2026-10-30 00:00:00.000', '2026-11-06 00:00:00.000');
