-- CreateTable
CREATE TABLE `users` (
    `id` CHAR(36) NOT NULL,
    `google_sub_hash` CHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `users_google_sub_hash_key`(`google_sub_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NULL,
    `action` VARCHAR(64) NOT NULL,
    `target` VARCHAR(128) NULL,
    `metadata` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_logs_user_id_created_at_idx`(`user_id`, `created_at`),
    INDEX `audit_logs_action_created_at_idx`(`action`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `collection_types` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(32) NOT NULL,
    `label` VARCHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `collection_types_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_deletion_jobs` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `service` VARCHAR(64) NOT NULL,
    `state` VARCHAR(16) NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `last_error` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `completed_at` DATETIME(3) NULL,

    UNIQUE INDEX `user_deletion_jobs_user_id_service_key`(`user_id`, `service`),
    INDEX `user_deletion_jobs_state_created_at_idx`(`state`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Referentiel des types de collection. Insere ici plutot que dans un seed separe : les
-- catalogs n'y font plus de jointure (ils stockent le `typeCode` en clair), donc cette table
-- n'est plus qu'un libelle - un seed distinct pour cinq lignes stables serait un fichier de
-- plus a synchroniser sans rien garantir.
INSERT INTO `collection_types` (`id`, `code`, `label`) VALUES
  (UUID(), 'vinyl', 'Vinyles'),
  (UUID(), 'manga', 'Mangas'),
  (UUID(), 'movie', 'Films'),
  (UUID(), 'book',  'Livres'),
  (UUID(), 'game',  'Jeux');
