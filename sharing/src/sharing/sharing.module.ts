import { Module } from '@nestjs/common';
import { CatalogClientService } from './catalog-client.service';
import { CollectionAccessService } from './collection-access.service';
import { SharingController } from './sharing.controller';
import { SharingService } from './sharing.service';

@Module({
  controllers: [SharingController],
  providers: [SharingService, CollectionAccessService, CatalogClientService],
  exports: [SharingService, CollectionAccessService, CatalogClientService],
})
export class SharingModule {}
