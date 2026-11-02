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

-- Permission large, DEV UNIQUEMENT : `prisma migrate dev` cree une shadow database, ce qui
-- exige CREATE/DROP hors du schema du service (sinon P3014). En production chaque service
-- n'a de droits que sur son propre schema.
GRANT ALL PRIVILEGES ON *.* TO 'acervatim'@'%';
FLUSH PRIVILEGES;
