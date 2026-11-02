import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ApiCacheService } from '../common/cache/api-cache.service';

/**
 * Purge des entrees de cache perimees.
 *
 * MariaDB n'a pas de TTL sur les lignes : `expiresAt` est respecte a la **lecture** - une
 * entree perimee n'est jamais servie - mais rien ne la supprime. Le monolithe notait ce cron
 * « sprint ulterieur » et ne l'a jamais ecrit, si bien que `api_cache` ne fait que croitre.
 *
 * L'enjeu n'est pas la place mais la **latence** : `api_cache` est lue sur le chemin de chaque
 * recherche, et une table qui accumule des annees de lignes mortes finit par ralentir
 * l'operation la plus frequente du service.
 */
@Injectable()
export class CacheCleanupService {
  private readonly logger = new Logger(CacheCleanupService.name);

  constructor(private readonly cache: ApiCacheService) {}

  /** Nocturne : la purge balaie toute la table, ce n'est pas une operation d'heure de pointe. */
  @Cron('0 15 4 * * *')
  async purge(): Promise<void> {
    try {
      const count = await this.cache.pruneExpired();
      if (count > 0) {
        this.logger.log(`${count} entree(s) de cache perimee(s) purgee(s)`);
      }
    } catch (err) {
      this.logger.error(`purge du cache echouee : ${(err as Error).message}`);
    }
  }
}
