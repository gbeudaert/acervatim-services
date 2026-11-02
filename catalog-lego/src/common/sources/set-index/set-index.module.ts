import { Global, Module } from '@nestjs/common';
import { HarvestService } from './harvest.service';
import { SetIndexService } from './set-index.service';
import { ThemeSyncService } from './theme-sync.service';

/**
 * L'index local et son alimentation. Global : la recherche, l'API des themes et les routes
 * d'exploitation le consomment depuis trois modules distincts.
 */
@Global()
@Module({
  providers: [SetIndexService, ThemeSyncService, HarvestService],
  exports: [SetIndexService, ThemeSyncService, HarvestService],
})
export class SetIndexModule {}
