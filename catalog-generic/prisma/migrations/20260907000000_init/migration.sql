-- CreateTable
CREATE TABLE `collections` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `type_code` VARCHAR(32) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `item_count` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `collections_user_id_created_at_idx`(`user_id`, `created_at`),
    INDEX `collections_type_code_idx`(`type_code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `collection_nodes` (
    `id` CHAR(36) NOT NULL,
    `collection_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `parent_id` CHAR(36) NULL,
    `level` VARCHAR(32) NOT NULL,
    `unified_data` JSON NOT NULL,
    `sources` JSON NOT NULL,
    `user_data` JSON NOT NULL,
    `is_wishlist` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `collection_nodes_collection_id_level_idx`(`collection_id`, `level`),
    INDEX `collection_nodes_parent_id_idx`(`parent_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `items` (
    `id` CHAR(36) NOT NULL,
    `collection_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `node_id` CHAR(36) NULL,
    `volume` INTEGER NULL,
    `unified_data` JSON NOT NULL,
    `sources` JSON NOT NULL,
    `user_data` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `items_user_id_node_id_volume_key`(`user_id`, `node_id`, `volume`),
    INDEX `items_collection_id_created_at_idx`(`collection_id`, `created_at`),
    INDEX `items_node_id_idx`(`node_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
-- Toutes INTRA-schema. Celles qui manquent - vers `users` et `collection_types` - sont
-- exactement celles que le decoupage supprime : ces tables appartiennent a `identity`.
ALTER TABLE `collection_nodes` ADD CONSTRAINT `collection_nodes_collection_id_fkey`
    FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `collection_nodes` ADD CONSTRAINT `collection_nodes_parent_id_fkey`
    FOREIGN KEY (`parent_id`) REFERENCES `collection_nodes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `items` ADD CONSTRAINT `items_collection_id_fkey`
    FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `items` ADD CONSTRAINT `items_node_id_fkey`
    FOREIGN KEY (`node_id`) REFERENCES `collection_nodes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
