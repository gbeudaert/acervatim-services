import { Global, Module } from '@nestjs/common';
import { PremiumCacheInvalidator } from './premium-cache-invalidator.service';
import { PremiumService } from './premium.service';

/**
 * Le calcul du statut premium, et la notification de son changement au gateway.
 *
 * Global : `PremiumService` est la source de verite de `GET /internal/premium/:userId`,
 * qu'interrogent le gateway et `sharing`. Rien d'autre dans la constellation ne sait
 * repondre a cette question.
 */
@Global()
@Module({
  providers: [PremiumService, PremiumCacheInvalidator],
  exports: [PremiumService, PremiumCacheInvalidator],
})
export class PremiumModule {}
