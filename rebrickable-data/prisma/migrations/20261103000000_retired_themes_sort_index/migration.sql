-- Themes retires : absents du dernier themes.csv, gardes pour les sets qui les referencent.
-- AlterTable
ALTER TABLE `lego_themes` ADD COLUMN `retired_at` DATETIME(3) NULL;

-- Index inutilisable : la recherche par nom est un LIKE '%...%'.
-- DropIndex
DROP INDEX `lego_sets_name_idx` ON `lego_sets`;

-- Tri de toutes les listes : year desc, set_num asc.
-- CreateIndex
CREATE INDEX `lego_sets_year_set_num_idx` ON `lego_sets`(`year` DESC, `set_num` ASC);
