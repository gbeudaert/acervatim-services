import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BricksetHarvestService } from './brickset-harvest.service';
import { BricksetProcessor } from './brickset.processor';
import { BricksetService } from './brickset.service';
import { BRICKSET_QUEUE } from './brickset.types';

@Module({
  imports: [BullModule.registerQueue({ name: BRICKSET_QUEUE })],
  providers: [BricksetService, BricksetProcessor, BricksetHarvestService],
  exports: [BricksetService, BricksetHarvestService],
})
export class BricksetModule {}
