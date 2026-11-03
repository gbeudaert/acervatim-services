import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { InternalController } from './internal.controller';

@Module({
  imports: [CatalogModule],
  controllers: [InternalController],
})
export class InternalRoutesModule {}
