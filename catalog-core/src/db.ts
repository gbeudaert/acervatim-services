import { PrismaClient } from '@prisma/client';

/**
 * Le client Prisma du catalog qui consomme cette bibliotheque.
 *
 * `catalog-core` est compile **dans le contexte de son consommateur** (cf. le README) : le
 * `@prisma/client` importe ici est celui que le service a genere depuis son propre
 * `schema.prisma`. Les quatre catalogs ayant des modeles identiques - `Collection`,
 * `CollectionNode`, `Item` -, le meme code type-checke contre tous leurs clients.
 *
 * C'est ce qui permet de tenir l'invariant du 1 de architecture-microservices.md - « aucune
 * dependance directe entre deux `apps/` » - sans forker le CRUD : la bibliotheque ne connait
 * aucun schema en particulier, elle connait *la forme* du schema.
 */
export type CatalogDb = PrismaClient;

/** Jeton d'injection du client. Chaque catalog y branche son propre `PrismaService`. */
export const CATALOG_DB = Symbol('CATALOG_DB');
