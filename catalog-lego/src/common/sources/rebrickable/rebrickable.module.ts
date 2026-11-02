import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { RebrickableProcessor } from './rebrickable.processor';
import { RebrickableService } from './rebrickable.service';
import { REBRICKABLE_QUEUE } from './rebrickable.types';

/**
 * Global comme `HttpModule` : `RebrickableService` est injecte par la recherche, le moissonneur
 * et le sync des themes, qui vivent dans trois modules differents.
 */
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: REBRICKABLE_QUEUE })],
  providers: [RebrickableService, RebrickableProcessor],
  exports: [RebrickableService],
})
export class RebrickableModule {}
