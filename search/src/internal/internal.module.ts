import { Module } from '@nestjs/common';
import { SourcesModule } from '../sources/sources.module';
import { InternalController } from './internal.controller';

@Module({
  imports: [SourcesModule],
  controllers: [InternalController],
})
export class InternalRoutesModule {}
