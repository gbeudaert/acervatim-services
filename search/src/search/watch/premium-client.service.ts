import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalPremium } from '../../common/internal/contracts';
import {
  InternalCallError,
  InternalClientService,
} from '../../common/internal/internal-client.service';

/**
 * Statut premium aupres de `billing`, pour le **seul** rattrapage hebdomadaire.
 *
 * Les routes utilisateur n'en ont pas besoin : le principal signe porte deja le premium,
 * resolu par le gateway. Le job, lui, n'a pas de requete entrante, donc pas de principal - il
 * demande, une fois par compte et par passage.
 *
 * A l'inverse du client de `identity` (une information d'affichage, repli « pas premium »),
 * `billing` injoignable fait echouer le passage : repondre « pas premium » viderait la liste
 * des editions surveillees, et le passage se terminerait avec succes sans rien avoir verifie.
 */
@Injectable()
export class PremiumClientService {
  constructor(
    private readonly internal: InternalClientService,
    private readonly config: ConfigService,
  ) {}

  /** Faux quand `BILLING_BASE_URL` manque - mode autonome, ou personne n'est premium. */
  isConfigured(): boolean {
    return Boolean(this.config.get<string>('BILLING_BASE_URL'));
  }

  async isPremium(userId: string): Promise<boolean> {
    const baseUrl = this.config.get<string>('BILLING_BASE_URL');
    if (!baseUrl) return false;
    try {
      const res = await this.internal.request<InternalPremium>(
        baseUrl,
        `/internal/premium/${encodeURIComponent(userId)}`,
      );
      return res.premium;
    } catch (err) {
      if (err instanceof InternalCallError) {
        throw new BadGatewayException(`billing a repondu ${err.status}`);
      }
      throw err;
    }
  }
}
