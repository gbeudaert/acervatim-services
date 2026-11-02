import { Module } from '@nestjs/common';
import { SourcesController } from './sources.controller';
import { SourcesService } from './sources.service';

/**
 * Nomme `SourcesApiModule` pour ne pas entrer en collision avec
 * `common/sources/sources.module.ts`, qui cable le port de resolution de jeton.
 */
@Module({
  controllers: [SourcesController],
  providers: [SourcesService],
  exports: [SourcesService],
})
export class SourcesApiModule {}
