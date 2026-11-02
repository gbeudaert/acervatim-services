-- CreateTable
CREATE TABLE `subscriptions` (
    `user_id` CHAR(36) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `product_id` VARCHAR(64) NOT NULL,
    `purchase_token` VARCHAR(512) NOT NULL,
    `expires_at` BIGINT NOT NULL,
    `auto_renew` BOOLEAN NOT NULL DEFAULT true,
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_verified_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `cancel_reason` VARCHAR(64) NULL,

    UNIQUE INDEX `subscriptions_purchase_token_key`(`purchase_token`),
    INDEX `subscriptions_status_expires_at_idx`(`status`, `expires_at`),
    PRIMARY KEY (`user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `premium_grants` (
    `user_id` CHAR(36) NOT NULL,
    `reason` VARCHAR(32) NOT NULL,
    `granted_by` VARCHAR(64) NULL,
    `granted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` BIGINT NULL,
    `notes` TEXT NULL,

    PRIMARY KEY (`user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invitations` (
    `code_hash` CHAR(64) NOT NULL,
    `reason` VARCHAR(32) NOT NULL,
    `grants_premium` BOOLEAN NOT NULL DEFAULT false,
    `premium_expires_at` BIGINT NULL,
    `max_uses` INTEGER NOT NULL DEFAULT 1,
    `used_count` INTEGER NOT NULL DEFAULT 0,
    `expires_at` BIGINT NULL,
    `created_by` VARCHAR(64) NULL,
    `notes` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `invitations_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`code_hash`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invitation_redemptions` (
    `invitation_code_hash` CHAR(64) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `redeemed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `invitation_redemptions_user_id_idx`(`user_id`),
    PRIMARY KEY (`invitation_code_hash`, `user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
-- Seule FK du schema, et elle reste INTRA-service : la regle interdit les relations qui
-- franchissent une frontiere de service, pas les relations tout court.
ALTER TABLE `invitation_redemptions` ADD CONSTRAINT `invitation_redemptions_invitation_code_hash_fkey`
    FOREIGN KEY (`invitation_code_hash`) REFERENCES `invitations`(`code_hash`)
    ON DELETE CASCADE ON UPDATE CASCADE;
