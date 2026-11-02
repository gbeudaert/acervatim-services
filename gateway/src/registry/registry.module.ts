import { Module } from '@nestjs/common';
import { RoutingModule } from '../routing/routing.module';
import { RegistryController } from './registry.controller';
import { RegistryRebuildService } from './registry-rebuild.service';
import { RegistryService } from './registry.service';

@Module({
  imports: [RoutingModule],
  controllers: [RegistryController],
  providers: [RegistryService, RegistryRebuildService],
  exports: [RegistryService],
})
export class RegistryModule {}
