import { RequestMethod } from '@nestjs/common';
import { RouteInfo } from '@nestjs/common/interfaces';

/** Prefixe global, garde pour l'alignement du socle - aucune route de ce service n'y vit. */
export const GLOBAL_PREFIX = 'v1';

/**
 * Routes servies **hors** prefixe `/v1` : `/health*` (infra), `/internal/*` (contrat entre
 * services) et `/admin/*` (exploitation, comme `catalog-lego`). Ce sont les trois seules familles
 * exposees ; perdre une exclusion deplacerait silencieusement ses routes sous `/v1/...`, ou
 * personne ne les cherche. Verrouille par `http-prefix.spec.ts`.
 */
export const GLOBAL_PREFIX_EXCLUSIONS: RouteInfo[] = [
  { path: 'health', method: RequestMethod.ALL },
  { path: 'health/(.*)', method: RequestMethod.ALL },
  { path: 'internal/(.*)', method: RequestMethod.ALL },
  { path: 'admin/(.*)', method: RequestMethod.ALL },
];
