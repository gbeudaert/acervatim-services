import { Module } from '@nestjs/common';
import { DeletionSagaService } from './deletion-saga.service';
import { ExportFanoutService } from './export-fanout.service';
import { SagaParticipantsService } from './saga-participants.service';

/**
 * L'orchestration RGPD. C'est ce qui remplace `onDelete: Cascade`, qui ne franchit pas une
 * frontiere de schema.
 */
@Module({
  providers: [SagaParticipantsService, DeletionSagaService, ExportFanoutService],
  exports: [SagaParticipantsService, DeletionSagaService, ExportFanoutService],
})
export class SagaModule {}
