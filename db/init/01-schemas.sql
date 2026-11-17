-- Cree les schemas logiques de la constellation a la PREMIERE creation du volume
-- (non rejoue ensuite). Une seule instance MariaDB, un schema par service : c'est la
-- decision actee du 7 de ../../acervatim-docs/agent/backend/architecture-microservices.md.
--
-- Aucune FK ne franchit une frontiere de schema. Ce fichier ne cree que les bases vides ;
-- les tables viennent des migrations Prisma de chaque service.

CREATE DATABASE IF NOT EXISTS acv_gateway     CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS acv_core        CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS acv_billing     CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS acv_conn        CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS acv_sharing     CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS acv_search      CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS acv_cat_generic CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS acv_cat_manga   CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS acv_cat_vinyl   CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS acv_cat_lego    CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS acv_rebrickable CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Permission large, en developpement COMME en production : le compte unique `acervatim` sert
-- les onze schemas (separation des comptes par service reportee le 2026-11-16, a revoir selon
-- la charge), et l'entrypoint MariaDB ne lui donne de droits que sur MARIADB_DATABASE.
-- `prisma migrate dev` en a aussi besoin : il cree une shadow database, ce qui exige
-- CREATE/DROP hors du schema du service (sinon P3014).
GRANT ALL PRIVILEGES ON *.* TO 'acervatim'@'%';
FLUSH PRIVILEGES;
