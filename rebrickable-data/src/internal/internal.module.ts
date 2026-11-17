import { Module } from '@nestjs/common';
import { BricksetModule } from '../brickset/brickset.module';
import { CatalogModule } from '../catalog/catalog.module';
import { InternalController } from './internal.controller';

@Module({
  imports: [CatalogModule, BricksetModule],
  controllers: [InternalController],
})
export class InternalRoutesModule {}
