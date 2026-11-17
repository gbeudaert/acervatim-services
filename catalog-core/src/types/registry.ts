import { Inject, Injectable } from '@nestjs/common';
import { CollectionTypeProfile } from './common';
import { makeFallbackProfile } from './fallback';

/**
 * Jeton d'injection des profils servis par CE catalog.
 *
 * Dans le monolithe, `registry.ts` etait un `Record` en dur listant tous les types. C'est
 * precisement cette table en memoire que le decoupage par type fait passer au reseau (2 de
 * architecture-microservices.md) : chaque catalog n'enregistre plus que **ses** profils, et
 * le gateway route sur le `typeCode`.
 *
 * `catalog-generic` en declare trois (movie, book, game), `catalog-manga`, `catalog-vinyl` et
 * `catalog-lego` un seul chacun.
 */
export const COLLECTION_TYPE_PROFILES = Symbol('COLLECTION_TYPE_PROFILES');

@Injectable()
export class ProfileRegistry {
  private readonly byCode: ReadonlyMap<string, CollectionTypeProfile>;

  constructor(
    @Inject(COLLECTION_TYPE_PROFILES) profiles: CollectionTypeProfile[],
  ) {
    const map = new Map<string, CollectionTypeProfile>();
    for (const profile of profiles) {
      if (map.has(profile.code)) {
        throw new Error(`Duplicate collection type profile: ${profile.code}`);
      }
      map.set(profile.code, profile);
    }
    this.byCode = map;
  }

  /**
   * Profil d'un type, ou le profil permissif a defaut.
   *
   * Le repli est celui du monolithe - `unifiedData` accepte tel quel, type plat - et il garde
   * ici un second role : un catalog qui recevrait un type qu'il ne sert pas ne doit pas
   * planter, il doit se comporter comme avant. Le vrai garde-fou contre un mauvais routage
   * est le registre du gateway, pas ce repli.
   */
  get(typeCode: string): CollectionTypeProfile {
    return this.byCode.get(typeCode) ?? makeFallbackProfile(typeCode);
  }

  /** Codes reellement servis. Sert au diagnostic (`/health/ready`). */
  codes(): string[] {
    return [...this.byCode.keys()];
  }

  serves(typeCode: string): boolean {
    return this.byCode.has(typeCode);
  }
}
