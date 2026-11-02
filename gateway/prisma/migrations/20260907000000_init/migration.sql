-- CreateTable
CREATE TABLE `collection_registry` (
    `collection_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `type_code` VARCHAR(32) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `collection_registry_user_id_type_code_idx`(`user_id`, `type_code`),
    PRIMARY KEY (`collection_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `resource_registry` (
    `resource_id` CHAR(36) NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `collection_id` CHAR(36) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `resource_registry_collection_id_idx`(`collection_id`),
    PRIMARY KEY (`resource_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `registry_rebuild_runs` (
    `id` CHAR(36) NOT NULL,
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finished_at` DATETIME(3) NULL,
    `state` VARCHAR(16) NOT NULL DEFAULT 'running',
    `scanned` INTEGER NOT NULL DEFAULT 0,
    `added` INTEGER NOT NULL DEFAULT 0,
    `removed` INTEGER NOT NULL DEFAULT 0,
    `corrected` INTEGER NOT NULL DEFAULT 0,
    `last_error` TEXT NULL,

    INDEX `registry_rebuild_runs_started_at_idx`(`started_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
