import { Module } from '@nestjs/common';
import { BricksetModule } from '../brickset/brickset.module';
import { ImportModule } from '../import/import.module';
import { DailyRefreshService } from './daily-refresh.service';

@Module({
  imports: [ImportModule, BricksetModule],
  providers: [DailyRefreshService],
})
export class JobsModule {}
