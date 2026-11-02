import { Module } from '@nestjs/common';
import { RoutingModule } from '../routing/routing.module';
import { AccessResolverService } from './access-resolver.service';
import { PremiumCacheController } from './premium-cache.controller';
import { PremiumCacheService } from './premium-cache.service';
import { PrincipalService } from './principal.service';

/**
 * Tout ce qui etablit « qui appelle, et a quel titre » avant qu'une requete parte en aval.
 * Les trois gardes du monolithe vivent ici depuis le decoupage.
 */
@Module({
  imports: [RoutingModule],
  controllers: [PremiumCacheController],
  providers: [PrincipalService, PremiumCacheService, AccessResolverService],
  exports: [PrincipalService, PremiumCacheService, AccessResolverService],
})
export class PrincipalModule {}
