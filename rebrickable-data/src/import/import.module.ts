import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { RebrickableCsvService } from './rebrickable-csv.service';

@Module({
  imports: [CatalogModule],
  providers: [RebrickableCsvService],
  exports: [RebrickableCsvService],
})
export class ImportModule {}
