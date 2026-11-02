import { Module } from '@nestjs/common';
import { SourcesApiModule } from '../sources/sources-api.module';
import { InternalController } from './internal.controller';

@Module({
  imports: [SourcesApiModule],
  controllers: [InternalController],
})
export class InternalModule {}
