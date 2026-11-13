import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { BGG_CLIENT, BggHttpClient } from './bgg.client';
import { BggProcessor } from './bgg.processor';
import { BggThingService } from './bgg.service';
import { BGG_QUEUE } from './bgg.types';

/**
 * Global : `BggThingService` enrichit la résolution des codes-barres de jeux de société. Même
 * découpage que GameUPC — producteur, worker, client derrière une interface.
 */
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: BGG_QUEUE })],
  providers: [
    BggHttpClient,
    { provide: BGG_CLIENT, useExisting: BggHttpClient },
    BggThingService,
    BggProcessor,
  ],
  exports: [BggThingService],
})
export class BggModule {}
