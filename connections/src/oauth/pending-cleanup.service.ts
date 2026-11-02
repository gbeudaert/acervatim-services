import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ApiCacheService } from '../common/cache/api-cache.service';

/**
 * Purge des flux OAuth en attente expires.
 *
 * MariaDB n'a pas de TTL sur les lignes : `api_cache.expiresAt` est respecte a la **lecture**
 * (une ligne perimee n'est jamais servie), mais rien ne la supprime. Dans le monolithe, ce
 * cron etait note « sprint ulterieur » et n'a jamais ete ecrit ; ici il ne peut pas attendre,
 * parce que ce que cette table contient a change de nature : ce ne sont plus des reponses
 * publiques de catalogue, ce sont des **secrets de flux** - token secret OAuth 1.0a,
 * `code_verifier` PKCE - et l'identite de l'utilisateur qui a lance chaque flux.
 *
 * Une ligne expiree n'est plus exploitable par le callback, mais elle reste lisible par qui
 * accede a la base. La supprimer est le minimum.
 */
@Injectable()
export class PendingCleanupService {
  private readonly logger = new Logger(PendingCleanupService.name);

  constructor(private readonly cache: ApiCacheService) {}

  /** Toutes les heures : le TTL des flux est de dix minutes, l'ecart reste faible. */
  @Cron('0 7 * * * *')
  async purge(): Promise<void> {
    try {
      const count = await this.cache.pruneExpired();
      if (count > 0) {
        this.logger.log(`${count} flux OAuth expire(s) purge(s)`);
      }
    } catch (err) {
      this.logger.error(`purge des flux expires echouee : ${(err as Error).message}`);
    }
  }
}
