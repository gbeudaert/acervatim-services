import { Module } from '@nestjs/common';
import { SharingModule } from '../sharing/sharing.module';
import { InternalController } from './internal.controller';

@Module({
  imports: [SharingModule],
  controllers: [InternalController],
})
export class InternalRoutesModule {}
