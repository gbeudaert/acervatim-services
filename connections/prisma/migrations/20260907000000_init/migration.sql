-- CreateTable
CREATE TABLE `oauth_credentials` (
    `user_id` CHAR(36) NOT NULL,
    `provider` VARCHAR(32) NOT NULL,
    `access_token_encrypted` TEXT NOT NULL,
    `refresh_token_encrypted` TEXT NULL,
    `expires_at` BIGINT NOT NULL DEFAULT 0,
    `scopes` JSON NOT NULL,
    `encrypted_with_key_version` INTEGER NOT NULL DEFAULT 1,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`user_id`, `provider`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `api_cache` (
    `cache_key` VARCHAR(255) NOT NULL,
    `payload` JSON NOT NULL,
    `fetched_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,

    INDEX `api_cache_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`cache_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
