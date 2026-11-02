import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalPremium } from '../common/internal/contracts';
import { InternalClientService } from '../common/internal/internal-client.service';

/**
 * Lecture du statut premium aupres de `billing`, pour `GET /v1/me` seulement.
 *
 * Le principal signe porte deja un booleen `premium`, mais le contrat V1 de `/v1/me` expose
 * `{ isPremium, source, expiresAt }` - l'app affiche la source et l'echeance. Reduire cette
 * reponse au booleen du principal serait un changement de contrat pour economiser un appel
 * sur une route consultee une fois par ouverture d'application.
 *
 * `billing` injoignable ne fait pas echouer `/v1/me` : un profil doit rester lisible quand
 * la facturation est en panne. On rend alors « pas premium », qui est le repli sur pour une
 * information d'affichage.
 */
@Injectable()
export class PremiumClientService {
  private readonly logger = new Logger(PremiumClientService.name);

  constructor(
    private readonly internal: InternalClientService,
    private readonly config: ConfigService,
  ) {}

  async status(
    userId: string,
  ): Promise<{ isPremium: boolean; source: string; expiresAt: number | null }> {
    const baseUrl = this.config.get<string>('BILLING_BASE_URL');
    if (!baseUrl) {
      return { isPremium: false, source: 'none', expiresAt: null };
    }
    const res = await this.internal.tryRequest<InternalPremium>(
      baseUrl,
      `/internal/premium/${encodeURIComponent(userId)}`,
    );
    if (!res) {
      this.logger.warn('billing injoignable - /v1/me rend premium=false');
      return { isPremium: false, source: 'none', expiresAt: null };
    }
    // Renomme `premium` en `isPremium` : c'est la forme que l'app lit depuis la V1.
    return {
      isPremium: res.premium,
      source: res.source,
      expiresAt: res.expiresAt,
    };
  }
}
