import { Module } from '@nestjs/common';
import { SagaModule } from '../saga/saga.module';
import { InternalController } from './internal.controller';

@Module({
  imports: [SagaModule],
  controllers: [InternalController],
})
export class InternalRoutesModule {}
