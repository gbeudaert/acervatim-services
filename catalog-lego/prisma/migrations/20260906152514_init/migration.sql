-- CreateTable
CREATE TABLE `api_cache` (
    `cache_key` VARCHAR(255) NOT NULL,
    `payload` JSON NOT NULL,
    `fetched_at` DATETIME(3) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,

    INDEX `api_cache_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`cache_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `lego_themes` (
    `id` INTEGER NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(255) NOT NULL,
    `parent_id` INTEGER NULL,
    `path` VARCHAR(512) NOT NULL,
    `depth` INTEGER NOT NULL DEFAULT 0,
    `synced_at` DATETIME(3) NOT NULL,

    INDEX `lego_themes_parent_id_idx`(`parent_id`),
    UNIQUE INDEX `lego_themes_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `lego_sets` (
    `set_num` VARCHAR(32) NOT NULL,
    `name` VARCHAR(512) NOT NULL,
    `year` INTEGER NULL,
    `theme_id` INTEGER NULL,
    `num_parts` INTEGER NULL,
    `image_url` VARCHAR(1024) NULL,
    `ean` VARCHAR(14) NULL,
    `upc` VARCHAR(14) NULL,
    `brickset_id` INTEGER NULL,
    `sources` VARCHAR(64) NOT NULL DEFAULT 'rebrickable',
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `lego_sets_ean_idx`(`ean`),
    INDEX `lego_sets_upc_idx`(`upc`),
    INDEX `lego_sets_theme_id_idx`(`theme_id`),
    INDEX `lego_sets_name_idx`(`name`(191)),
    PRIMARY KEY (`set_num`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `harvest_runs` (
    `id` CHAR(36) NOT NULL,
    `source` VARCHAR(32) NOT NULL,
    `mode` VARCHAR(16) NOT NULL,
    `state` VARCHAR(16) NOT NULL DEFAULT 'running',
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finished_at` DATETIME(3) NULL,
    `last_page` INTEGER NOT NULL DEFAULT 0,
    `watermark` DATETIME(3) NULL,
    `calls_used` INTEGER NOT NULL DEFAULT 0,
    `sets_upserted` INTEGER NOT NULL DEFAULT 0,
    `last_error` TEXT NULL,

    INDEX `harvest_runs_source_state_idx`(`source`, `state`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `source_credentials` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `provider` VARCHAR(32) NOT NULL,
    `encrypted_key` TEXT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `source_credentials_user_id_provider_key`(`user_id`, `provider`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
