import {
  CollectionTypeProfile,
  makeFallbackProfile,
} from '../catalog-core/src';

/**
 * Les types servis par ce catalog : `movie`, `book` et `game`.
 *
 * **Trois types, un seul processus.** L'architecture les regroupe (1 et 2 de
 * architecture-microservices.md) parce que leurs profils ne different pas assez pour justifier
 * trois processus Node+Prisma - un decoupage se paie en memoire et en pipelines, et il doit
 * acheter quelque chose.
 *
 * Les trois utilisent aujourd'hui le **profil permissif** : `unifiedData` accepte tel quel,
 * type plat, projection de liste generique. C'est l'etat du monolithe, ou seuls `manga` et
 * `vinyl` etaient modelises. Le jour ou l'un d'eux merite un vrai profil, il se declare ici -
 * et s'il devenait assez lourd pour justifier son propre processus, il quitterait ce fichier
 * pour un service a lui, sans que le CRUD bouge.
 */
export const PROFILES: CollectionTypeProfile[] = [
  makeFallbackProfile('movie'),
  makeFallbackProfile('book'),
  makeFallbackProfile('game'),
];
