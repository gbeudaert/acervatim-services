import { CollectionTypeProfile, legoProfile } from '../catalog-core/src';

/**
 * Les types servis par ce catalog.
 *
 * **C'est le seul fichier qui distingue ce service de `catalog-vinyl`.** Tout le reste vient de
 * `@acervatim/catalog-core` (cf. le 2 de architecture-microservices.md).
 *
 * Le LEGO est un type **plat** : un item est une boite. `hierarchy` est vide, donc `node`,
 * `nodeId` et `volume` sont refuses en `400` sur ce catalog. Le catalogue des sets n'est pas ici :
 * il vit dans `rebrickable-data`, que l'app interroge par `GET /v1/search?type=lego` (`search`).
 */
export const PROFILES: CollectionTypeProfile[] = [legoProfile];
