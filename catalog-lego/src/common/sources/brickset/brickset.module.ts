import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { BricksetProcessor } from './brickset.processor';
import { BricksetService } from './brickset.service';
import { BRICKSET_QUEUE } from './brickset.types';

@Global()
@Module({
  imports: [BullModule.registerQueue({ name: BRICKSET_QUEUE })],
  providers: [BricksetService, BricksetProcessor],
  exports: [BricksetService],
})
export class BricksetModule {}
