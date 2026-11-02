import { Global, Module } from '@nestjs/common';
import { ServiceRegistryService } from './service-registry.service';

/**
 * La table nom-de-service -> adresse. Globale : le proxy, le scatter-gather, la resolution
 * d'acces et le job de reparation du registre la lisent tous, et elle est sans etat une
 * fois construite.
 */
@Global()
@Module({
  providers: [ServiceRegistryService],
  exports: [ServiceRegistryService],
})
export class RoutingModule {}
