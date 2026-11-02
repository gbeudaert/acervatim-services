-- CreateTable
CREATE TABLE `api_cache` (
    `cache_key` VARCHAR(255) NOT NULL,
    `payload` JSON NOT NULL,
    `fetched_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,

    INDEX `api_cache_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`cache_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
