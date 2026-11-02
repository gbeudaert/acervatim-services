import { CollectionTypeProfile, vinylProfile } from '../catalog-core/src';

/**
 * Les types servis par ce catalog.
 *
 * **C'est le seul fichier qui distingue ce service de `catalog-manga`.** Tout le reste vient de
 * `@acervatim/catalog-core` (cf. le 2 de architecture-microservices.md).
 *
 * Le vinyle est un type **plat** : `hierarchy` est vide, donc `node`, `nodeId` et `volume` sont
 * refuses en `400` sur ce catalog, et `/v1/collections/:id/nodes` n'y a pas de sens. Le meme
 * code sert les deux cas - c'est le profil qui tranche, pas une branche dans le CRUD.
 */
export const PROFILES: CollectionTypeProfile[] = [vinylProfile];
