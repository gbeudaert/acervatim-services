import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { GAMEUPC_CLIENT, GameUpcHttpClient } from './gameupc.client';
import { GameUpcFeedbackProcessor } from './gameupc-feedback.processor';
import { GameUpcLookupProcessor } from './gameupc.processor';
import { GameUpcService } from './gameupc.service';
import { GAMEUPC_FEEDBACK_QUEUE, GAMEUPC_QUEUE } from './gameupc.types';

/**
 * Global (comme `GoogleBooksModule`) : `GameUpcService` sert la résolution des codes-barres de
 * jeux de société dans `search/boardgame/`.
 *
 * Découpage : `GameUpcService` (producteur cache + enqueue), `GameUpcLookupProcessor` et
 * `GameUpcFeedbackProcessor` (workers, seuls à appeler GameUPC), `GameUpcClient` (appel HTTP pur,
 * derrière une interface pour que les tests et un éventuel autre fournisseur s'y substituent).
 */
@Global()
@Module({
  imports: [
    BullModule.registerQueue(
      { name: GAMEUPC_QUEUE },
      { name: GAMEUPC_FEEDBACK_QUEUE },
    ),
  ],
  providers: [
    GameUpcHttpClient,
    { provide: GAMEUPC_CLIENT, useExisting: GameUpcHttpClient },
    GameUpcService,
    GameUpcLookupProcessor,
    GameUpcFeedbackProcessor,
  ],
  exports: [GameUpcService],
})
export class GameUpcModule {}
