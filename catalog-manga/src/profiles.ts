import { CollectionTypeProfile, mangaProfile } from '../catalog-core/src';

/**
 * Les types servis par ce catalog.
 *
 * **C'est le seul fichier qui distingue ce service de `catalog-vinyl`.** Tout le reste - CRUD,
 * pagination, filtrage par statut, routes internes, plafonds - vient de
 * `@acervatim/catalog-core`.
 *
 * C'est aussi ce que le 2 de architecture-microservices.md annonce : ce qui differe entre deux
 * catalogs tient dans un `itemSchema`, une `toListProjection`, une `hierarchy` et un
 * `reconcileOnUpdate` optionnel. Le monolithe en faisait deja un point d'extension propre ; le
 * decoupage n'a fait que porter cette frontiere du `Record` en memoire au reseau.
 */
export const PROFILES: CollectionTypeProfile[] = [mangaProfile];
