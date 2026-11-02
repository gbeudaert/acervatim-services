import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { SourcesModule } from '../sources/sources.module';
import { EditionImportController } from './import/edition-import.controller';
import { EditionImportProcessor } from './import/edition-import.processor';
import { EditionImportService } from './import/edition-import.service';
import { EDITION_IMPORT_QUEUE } from './import/edition-import.types';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { CatalogClientService } from './watch/catalog-client.service';
import { EditionWatchProcessor } from './watch/edition-watch.processor';
import { EditionWatchService } from './watch/edition-watch.service';
import { EDITION_WATCH_QUEUE } from './watch/edition-watch.types';
import { PremiumClientService } from './watch/premium-client.service';
import { SeriesUpdatesController } from './watch/series-updates.controller';

@Module({
  imports: [
    SourcesModule,
    BullModule.registerQueue(
      { name: EDITION_IMPORT_QUEUE },
      // Rattrapage hebdomadaire des séries en cours (SD3) : réutilise SearchService, d'où sa place ici.
      { name: EDITION_WATCH_QUEUE },
    ),
  ],
  controllers: [
    SearchController,
    EditionImportController,
    SeriesUpdatesController,
  ],
  providers: [
    SearchService,
    EditionImportService,
    EditionImportProcessor,
    EditionWatchService,
    EditionWatchProcessor,
    CatalogClientService,
    PremiumClientService,
  ],
  exports: [SearchService],
})
export class SearchModule {}
