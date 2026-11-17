import { DynamicModule, Module, Provider, Type } from '@nestjs/common';
import {
  CATALOG_CONFIG,
  CatalogConfig,
  INTERNAL_TRANSPORT,
  RegistryClientService,
} from './clients/registry-client.service';
import { SnapshotClientService } from './clients/snapshot-client.service';
import { CollectionAccessGuard } from './collection-access.guard';
import { CollectionsController } from './collections/collections.controller';
import { CollectionsService } from './collections/collections.service';
import { CATALOG_DB } from './db';
import { CatalogInternalController } from './internal/catalog-internal.controller';
import { CatalogInternalService } from './internal/catalog-internal.service';
import { ItemsController } from './items/items.controller';
import { ItemsService } from './items/items.service';
import { LimitsService } from './limits.service';
import { NodesController } from './nodes/nodes.controller';
import { NodesService } from './nodes/nodes.service';
import { ShareFilterService } from './share-filter.service';
import { CollectionTypeProfile } from './types/common';
import { COLLECTION_TYPE_PROFILES, ProfileRegistry } from './types/registry';

/**
 * Controleurs des routes publiques (`/v1/*`). Le catalog y pose `PrincipalMiddleware`.
 *
 * Exportes pour que le middleware s'accroche **aux controleurs** et non a un motif de chemin :
 * `forRoutes({ path: 'v1/(.*)' })` etait prefixe une seconde fois par le prefixe global
 * (`/v1/v1/(.*)`), et `internal/(.*)` part tel quel a Express 4, dont l'analyseur de chemin
 * lit `(.*)` comme « un point, puis n'importe quoi ». Aucun des deux ne s'appliquait : identite
 * jamais posee (500 sur toute ecriture), routes internes ouvertes sans jeton. Accroche aux
 * controleurs, Nest calcule lui-meme les chemins exacts, prefixe et exclusions compris.
 */
export const CATALOG_PUBLIC_CONTROLLERS: Type<unknown>[] = [
  CollectionsController,
  ItemsController,
  NodesController,
];

/** Controleurs des routes `/internal/*`. Le catalog y pose `InternalTokenMiddleware`. */
export const CATALOG_INTERNAL_CONTROLLERS: Type<unknown>[] = [
  CatalogInternalController,
];

export interface CatalogCoreOptions {
  /**
   * Profils de type servis par CE catalog. `catalog-generic` en declare trois, `catalog-manga`,
   * `catalog-vinyl` et `catalog-lego` un seul chacun.
   */
  profiles: CollectionTypeProfile[];
  /** Le `PrismaService` du service catalog. */
  db: Type<unknown>;
  /** Le `InternalClientService` de son socle - `catalog-core` n'a pas le sien. */
  internalTransport: Type<unknown>;
  /** URLs des voisins, resolues par le service depuis sa configuration. */
  configFactory: Provider;
}

/**
 * Le CRUD collections / noeuds / items, mutualise par les quatre catalogs.
 *
 * ### Pourquoi cette bibliotheque existe
 *
 * `catalog-manga` et `catalog-vinyl` partagent l'essentiel de leur code : le CRUD est
 * identique, et ce qui differe tient dans un `itemSchema`, une `toListProjection`, une
 * `hierarchy` (vide pour le vinyle) et un `reconcileOnUpdate` optionnel - c'est-a-dire dans un
 * `CollectionTypeProfile`. Le monolithe en faisait deja un point d'extension propre
 * (`collections/types/registry.ts`), et c'est precisement ce qui rend le decoupage par type
 * **possible** : la frontiere existait, il s'agissait de la faire passer du `Record` en
 * memoire au reseau (2 de architecture-microservices.md).
 *
 * Recopier ce CRUD dans chaque catalog creerait exactement la divergence que le decoupage
 * cherche a eviter : plusieurs implementations du meme code, qui derivent au premier correctif
 * applique d'un seul cote. C'est pour cela que `catalog-lego`, d'abord ecrit comme une stack
 * autonome, a ete refait sur cette bibliotheque (2026-11-17) au lieu de garder son propre code.
 *
 * ### Ce qu'elle ne contient pas
 *
 * Le socle technique - gardes, filtre RFC 9457, journal d'acces, client interne - reste dans
 * chaque service. Cette bibliotheque n'est pas un second socle : elle ne contient que le
 * domaine, et recoit du service ce dont elle a besoin (base, transport, configuration).
 */
@Module({})
export class CatalogCoreModule {
  static register(options: CatalogCoreOptions): DynamicModule {
    return {
      module: CatalogCoreModule,
      controllers: [...CATALOG_PUBLIC_CONTROLLERS, ...CATALOG_INTERNAL_CONTROLLERS],
      providers: [
        { provide: COLLECTION_TYPE_PROFILES, useValue: options.profiles },
        { provide: CATALOG_DB, useExisting: options.db },
        { provide: INTERNAL_TRANSPORT, useExisting: options.internalTransport },
        options.configFactory,
        ProfileRegistry,
        LimitsService,
        ShareFilterService,
        RegistryClientService,
        SnapshotClientService,
        CollectionAccessGuard,
        CollectionsService,
        ItemsService,
        NodesService,
        CatalogInternalService,
      ],
      exports: [
        ProfileRegistry,
        CatalogInternalService,
        CollectionsService,
        ItemsService,
        NodesService,
      ],
    };
  }
}

export { CATALOG_CONFIG };
export type { CatalogConfig };
