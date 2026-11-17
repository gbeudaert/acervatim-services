import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BggModule } from './bgg/bgg.module';
import { BnfModule } from './bnf/bnf.module';
import { CacheCleanupService } from './cache-cleanup.service';
import { GameUpcModule } from './gameupc/gameupc.module';
import { GoogleBooksModule } from './googlebooks/googlebooks.module';
import { MangaDexModule } from './mangadex/mangadex.module';
import { DiscogsAdapter } from './adapters/discogs.adapter';
import { DiscogsProcessor } from './adapters/discogs.processor';
import { DISCOGS_QUEUE } from './adapters/discogs.types';
import { MalAdapter } from './adapters/mal.adapter';
import { MalProcessor } from './adapters/mal.processor';
import { MAL_QUEUE } from './adapters/mal.types';
import { TmdbAdapter } from './adapters/tmdb.adapter';
import { TmdbProcessor } from './adapters/tmdb.processor';
import { TMDB_QUEUE } from './adapters/tmdb.types';
import { RebrickableAdapter } from './rebrickable/rebrickable.adapter';
import {
  SOURCE_ADAPTERS,
  SourceSnapshotService,
} from './source-snapshot.service';
import { TokenClientService } from './token-client.service';

/**
 * Les adapters de source et leurs files.
 *
 * Ils viennent de `oauth/providers/` du monolithe et ont suivi **`search`**, pas
 * `connections` : ce sont eux qui appellent les catalogues externes, tiennent les files
 * BullMQ et portent les cles serveur Acervatim. Leur moitie « flux OAuth » est restee dans
 * `connections`, qui detient les jetons des utilisateurs.
 *
 * La frontiere entre les deux est `TokenClientService` -> `GET /internal/token/:userId/:provider`.
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: TMDB_QUEUE }),
    BullModule.registerQueue({ name: MAL_QUEUE }),
    BullModule.registerQueue({ name: DISCOGS_QUEUE }),
    BnfModule,
    GoogleBooksModule,
    MangaDexModule,
    GameUpcModule,
    BggModule,
  ],
  providers: [
    TokenClientService,
    CacheCleanupService,
    SourceSnapshotService,
    DiscogsAdapter,
    DiscogsProcessor,
    MalAdapter,
    MalProcessor,
    TmdbAdapter,
    TmdbProcessor,
    RebrickableAdapter,
    {
      provide: SOURCE_ADAPTERS,
      useFactory: (
        discogs: DiscogsAdapter,
        mal: MalAdapter,
        tmdb: TmdbAdapter,
        rebrickable: RebrickableAdapter,
      ) => [discogs, mal, tmdb, rebrickable],
      inject: [DiscogsAdapter, MalAdapter, TmdbAdapter, RebrickableAdapter],
    },
  ],
  exports: [
    SOURCE_ADAPTERS,
    SourceSnapshotService,
    TokenClientService,
    DiscogsAdapter,
    MalAdapter,
    TmdbAdapter,
  ],
})
export class SourcesModule {}
