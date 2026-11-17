import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { BricksetLookupService } from './brickset-lookup.service';
import { BricksetProcessor } from './brickset.processor';
import { BricksetService } from './brickset.service';
import { BRICKSET_QUEUE } from './brickset.types';

@Module({
  imports: [BullModule.registerQueue({ name: BRICKSET_QUEUE }), CatalogModule],
  providers: [BricksetService, BricksetProcessor, BricksetLookupService],
  exports: [BricksetService, BricksetLookupService],
})
export class BricksetModule {}
