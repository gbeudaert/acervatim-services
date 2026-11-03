import { Module } from '@nestjs/common';
import { BricksetModule } from '../brickset/brickset.module';
import { CatalogModule } from '../catalog/catalog.module';
import { ImportModule } from '../import/import.module';
import { AdminController } from './admin.controller';

@Module({
  imports: [CatalogModule, ImportModule, BricksetModule],
  controllers: [AdminController],
})
export class AdminModule {}
