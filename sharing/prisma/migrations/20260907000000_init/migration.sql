-- CreateTable
CREATE TABLE `collection_shares` (
    `id` CHAR(36) NOT NULL,
    `owner_user_id` CHAR(36) NOT NULL,
    `code_hash` CHAR(64) NOT NULL,
    `label` VARCHAR(200) NULL,
    `max_uses` INTEGER NOT NULL DEFAULT 1,
    `used_count` INTEGER NOT NULL DEFAULT 0,
    `expires_at` BIGINT NULL,
    `revoked_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `collection_shares_code_hash_key`(`code_hash`),
    INDEX `collection_shares_owner_user_id_idx`(`owner_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `collection_share_entries` (
    `share_id` CHAR(36) NOT NULL,
    `collection_id` CHAR(36) NOT NULL,
    `statuses` JSON NOT NULL,
    `collection_name` VARCHAR(255) NOT NULL,
    `type_code` VARCHAR(32) NOT NULL,

    INDEX `collection_share_entries_collection_id_idx`(`collection_id`),
    INDEX `collection_share_entries_type_code_idx`(`type_code`),
    PRIMARY KEY (`share_id`, `collection_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `collection_share_members` (
    `share_id` CHAR(36) NOT NULL,
    `member_user_id` CHAR(36) NOT NULL,
    `label` VARCHAR(200) NULL,
    `redeemed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revoked_at` DATETIME(3) NULL,

    INDEX `collection_share_members_member_user_id_idx`(`member_user_id`),
    PRIMARY KEY (`share_id`, `member_user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
-- Les deux seules FK du schema, toutes deux INTRA-service. Celle qui manque - vers
-- `collections` - est justement celle que le decoupage supprime : la collection vit dans un
-- `catalog-*`, et `collection_id` reste une colonne nue.
ALTER TABLE `collection_share_entries` ADD CONSTRAINT `collection_share_entries_share_id_fkey`
    FOREIGN KEY (`share_id`) REFERENCES `collection_shares`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `collection_share_members` ADD CONSTRAINT `collection_share_members_share_id_fkey`
    FOREIGN KEY (`share_id`) REFERENCES `collection_shares`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
