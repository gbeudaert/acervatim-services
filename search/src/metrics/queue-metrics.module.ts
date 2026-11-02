import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BNF_QUEUE } from '../sources/bnf/bnf.types';
import { GBOOKS_QUEUE } from '../sources/googlebooks/googlebooks.types';
import { DISCOGS_QUEUE } from '../sources/adapters/discogs.types';
import { MAL_QUEUE } from '../sources/adapters/mal.types';
import { TMDB_QUEUE } from '../sources/adapters/tmdb.types';
import { EDITION_IMPORT_QUEUE } from '../search/import/edition-import.types';
import { EDITION_WATCH_QUEUE } from '../search/watch/edition-watch.types';
import { QueueMetricsController } from './queue-metrics.controller';
import { QueueMetricsService } from './queue-metrics.service';

/**
 * Observabilite transverse des files BullMQ : agrege les compteurs de **toutes** les files
 * (d'ou l'enregistrement des sept noms ici - chaque file reste par ailleurs enregistree dans son
 * module feature). `RedisHealthService` et `AdminGuard` sont fournis globalement.
 *
 * Sert `/v1/admin/queues`, qui reste dans le contrat public : le gateway y route sous
 * `auth: 'admin'`. Toutes les files du systeme ayant suivi ce service, c'est ici et nulle part
 * ailleurs que la passerelle sortante s'observe.
 */
@Module({
  imports: [
    BullModule.registerQueue(
      { name: GBOOKS_QUEUE },
      { name: BNF_QUEUE },
      { name: MAL_QUEUE },
      { name: DISCOGS_QUEUE },
      { name: TMDB_QUEUE },
      { name: EDITION_IMPORT_QUEUE },
      { name: EDITION_WATCH_QUEUE },
    ),
  ],
  controllers: [QueueMetricsController],
  providers: [QueueMetricsService],
})
export class QueueMetricsModule {}
