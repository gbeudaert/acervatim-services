-- Type de collection LEGO, servi par `catalog-lego` (2026-11-17).
--
-- `INSERT IGNORE` sur la cle unique `code` : la migration passe aussi sur une base ou la ligne
-- aurait ete ajoutee a la main, sans doublon ni erreur.
INSERT IGNORE INTO `collection_types` (`id`, `code`, `label`) VALUES
  (UUID(), 'lego', 'LEGO');
