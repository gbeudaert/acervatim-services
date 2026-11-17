-- Brickset au scan (decision du 2026-11-16) : chaque code garde la date de l'appel qui l'a
-- confirme, et s'efface 90 jours plus tard.
-- AlterTable
ALTER TABLE `lego_sets` ADD COLUMN `barcode_checked_at` DATETIME(3) NULL;

-- Un code sans date vient de l'ancien moissonnage : sans echeance, il ne peut pas tenir
-- l'engagement des 90 jours. Il est efface ; le prochain scan le redemandera.
UPDATE `lego_sets`
SET `ean` = NULL, `upc` = NULL, `brickset_id` = NULL
WHERE `barcode_checked_at` IS NULL
  AND (`ean` IS NOT NULL OR `upc` IS NOT NULL OR `brickset_id` IS NOT NULL);

-- Purge quotidienne des codes expires.
-- CreateIndex
CREATE INDEX `lego_sets_barcode_checked_at_idx` ON `lego_sets`(`barcode_checked_at`);
