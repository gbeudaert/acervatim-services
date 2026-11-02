import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalClientService } from '../common/internal/internal-client.service';

/**
 * Previent le gateway qu'un statut premium vient de changer (3.6).
 *
 * Le gateway met `GET /internal/premium/:userId` en cache 60 s. Ce TTL est acceptable dans un
 * seul sens : une **perte** de premium peut mettre une minute a produire effet, ce qui est
 * sans consequence puisqu'elle suspend les partages sans rien detruire. Dans l'autre sens il
 * ne l'est pas - un utilisateur qui vient de payer ne doit pas se voir refuser ses propres
 * collections en `402` pendant une minute.
 *
 * **Best-effort** : si le gateway ne repond pas, l'achat reste enregistre et le TTL fait le
 * travail avec du retard. Faire echouer une verification d'achat parce qu'un cache n'a pas pu
 * etre vide serait hors de proportion - et laisserait Google Play croire que l'achat n'a pas
 * ete pris en compte.
 */
@Injectable()
export class PremiumCacheInvalidator {
  private readonly logger = new Logger(PremiumCacheInvalidator.name);

  constructor(
    private readonly internal: InternalClientService,
    private readonly config: ConfigService,
  ) {}

  async invalidate(userId: string): Promise<void> {
    const baseUrl = this.config.get<string>('GATEWAY_BASE_URL');
    if (!baseUrl) return;
    const res = await this.internal.tryRequest<null>(
      baseUrl,
      `/internal/premium-cache/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    );
    if (res === null) {
      this.logger.debug(
        `invalidation du cache premium non confirmee - le TTL prendra le relais`,
      );
    }
  }
}
