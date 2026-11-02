import { Module } from '@nestjs/common';
import { PrincipalModule } from '../principal/principal.module';
import { RegistryModule } from '../registry/registry.module';
import { RoutingModule } from '../routing/routing.module';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';
import { RouteThrottleService } from './route-throttle.service';
import { ScatterGatherService } from './scatter-gather.service';

/**
 * A importer **en dernier** dans `AppModule` : son controleur est un attrape-tout, et Nest
 * apparie les routes dans l'ordre d'enregistrement. Place avant, il capterait `/health` et
 * `/internal/*` avant leurs propres controleurs.
 */
@Module({
  imports: [RoutingModule, RegistryModule, PrincipalModule],
  controllers: [ProxyController],
  providers: [ProxyService, ScatterGatherService, RouteThrottleService],
})
export class ProxyModule {}
