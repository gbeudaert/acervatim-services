/**
 * `@acervatim/catalog-core` - le CRUD collections / noeuds / items mutualise par les trois
 * services `catalog-*`.
 *
 * Un service catalog se reduit alors a : son schema Prisma, son socle technique, et la
 * declaration de ses profils de type. Voir le README pour la raison de ce decoupage et la
 * facon dont la bibliotheque est compilee.
 */

// Le module et ses options de cablage.
export {
  CatalogCoreModule,
  CATALOG_CONFIG,
  CATALOG_INTERNAL_CONTROLLERS,
  CATALOG_PUBLIC_CONTROLLERS,
} from './catalog-core.module';
export type { CatalogConfig, CatalogCoreOptions } from './catalog-core.module';

// Port de base.
export { CATALOG_DB } from './db';
export type { CatalogDb } from './db';

// Transport des appels internes, fourni par le socle du service.
export { INTERNAL_TRANSPORT } from './clients/registry-client.service';
export type { InternalTransport } from './clients/registry-client.service';
export { RegistryClientService } from './clients/registry-client.service';
export { SnapshotClientService } from './clients/snapshot-client.service';

// Acces resolu, garde et decorateurs.
export {
  accessFromPrincipal,
  accessStatuses,
  CurrentCollectionAccess,
} from './access';
export type { CollectionAccess, CollectionRole } from './access';
export {
  CollectionAccessGuard,
  CollectionRef,
} from './collection-access.guard';
export type { CollectionRefVia } from './collection-access.guard';
export { CurrentUserId } from './current-user-id.decorator';

// Profils de type : ce qui distingue un catalog d'un autre.
export type {
  CollectionTypeProfile,
  HierarchyLevel,
  ItemProjectionRow,
  LightItem,
  SourceEntry,
  SourceRef,
  SourceRefView,
} from './types/common';
export { isHierarchical, optionalUrl } from './types/common';
export { makeFallbackProfile } from './types/fallback';
export { legoProfile } from './types/lego';
export { mangaProfile } from './types/manga';
export { vinylProfile } from './types/vinyl';
export { summarizeHierarchy } from './types/hierarchy';
export type { HierarchySummaryEntry } from './types/hierarchy';
export { COLLECTION_TYPE_PROFILES, ProfileRegistry } from './types/registry';

// Domaine.
export { CollectionsService } from './collections/collections.service';
export type {
  CollectionDetailResponse,
  CollectionResponse,
} from './collections/collections.service';
export { ItemsService } from './items/items.service';
export type { CuratedItem } from './items/items.service';
export { NodesService } from './nodes/nodes.service';
export type { NodeResponse } from './nodes/nodes.service';
export { CatalogInternalService } from './internal/catalog-internal.service';

// Plafonds techniques et filtrage par statut.
export { LimitsService, TECHNICAL_LIMITS } from './limits.service';
export {
  isAllStatuses,
  itemVisibleUnderStatuses,
  ShareFilterService,
} from './share-filter.service';
export {
  sharedItemUserData,
  sharedNodeUserData,
  SHARED_ITEM_USER_DATA_KEYS,
  SHARED_NODE_USER_DATA_KEYS,
} from './sharing-projection';

// Vocabulaire des statuts d'item.
export {
  DEFAULT_ITEM_STATUS,
  DEFAULT_PLAY_COUNT,
  ITEM_STATUSES,
  ItemUserDataSchema,
  resolveItemStatus,
  resolvePlayCount,
} from './item-user-data.schema';
export type { ItemStatus, ItemUserData } from './item-user-data.schema';
export { NodeUserDataSchema, nodeUserDataShape } from './node-user-data.schema';

// Pagination, filtres et garde-fou de volume : le contrat V1 les impose a l'identique.
export { paginate, PaginationQuerySchema } from './pagination/paginate';
export type { CursorPage, PaginationQuery } from './pagination/paginate';
export { filterAll, filterIn, parseFilters, searchFilter } from './parse-filters';
export {
  boundedJsonRecord,
  UNIFIED_DATA_MAX_BYTES,
} from './validation/bounded-json';

// Contrat inter-services (copie du socle - voir AGENTS.md).
export * from './contracts';
