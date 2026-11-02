import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalPremium } from '../common/internal/contracts';
import { InternalClientService } from '../common/internal/internal-client.service';
import { OauthCredentialsService, OauthProvider } from './oauth.service';

/**
 * Decision de resolution d'un jeton pour une source externe, valable pour **tous** les
 * profils (cf. ../../../acervatim-docs/agent/transverse/sources-externes.md) :
 *  - `user`     : l'utilisateur a connecte la source -> on utilise **ses** jetons ;
 *  - `fallback` : pas de jeton personnel mais utilisateur premium -> l'appelant emploie sa
 *                 propre cle serveur pour cette source ;
 *  - `none`     : ni jeton personnel ni premium -> l'appelant sert le mode degrade (cache),
 *                 puis a defaut une erreur actionnable.
 */
export type TokenResolution =
  | {
      source: 'user';
      credentials: {
        accessToken: string;
        refreshToken?: string;
        expiresAtMs: number;
        scopes: string[];
      };
    }
  | { source: 'fallback' }
  | { source: 'none' };

/**
 * Resolution centrale des jetons. La logique est unique et volontairement independante du
 * profil : seul le repli est reserve au premium.
 *
 * **Ce service ne renvoie que la decision, jamais une cle serveur.** Les secrets par source
 * (`MAL_CLIENT_ID`, `TMDB_API_KEY`, consumer Discogs) restent portes par l'appelant -
 * c'etait deja la regle dans le monolithe, et le decoupage la rend structurelle : `search`
 * detient les cles Acervatim, `connections` detient celles des utilisateurs. Aucun des deux
 * n'a a connaitre les secrets de l'autre.
 *
 * Le premium vient de `billing`. S'il est injoignable, la resolution retombe sur `none`
 * plutot que sur `fallback` : accorder un repli premium qu'on ne sait pas verifier
 * consommerait la cle serveur Acervatim pour un utilisateur peut-etre gratuit, ce qui est
 * exactement le contraire du but de ce repli.
 */
@Injectable()
export class TokenResolverService {
  private readonly logger = new Logger(TokenResolverService.name);

  constructor(
    private readonly credentials: OauthCredentialsService,
    private readonly internal: InternalClientService,
    private readonly config: ConfigService,
  ) {}

  async resolve(
    userId: string,
    provider: OauthProvider,
  ): Promise<TokenResolution> {
    const userCredentials = await this.credentials.get(userId, provider);
    if (userCredentials) {
      return { source: 'user', credentials: userCredentials };
    }

    return (await this.isPremium(userId))
      ? { source: 'fallback' }
      : { source: 'none' };
  }

  private async isPremium(userId: string): Promise<boolean> {
    const baseUrl = this.config.get<string>('BILLING_BASE_URL');
    if (!baseUrl) return false;
    const res = await this.internal.tryRequest<InternalPremium>(
      baseUrl,
      `/internal/premium/${encodeURIComponent(userId)}`,
    );
    if (!res) {
      this.logger.warn(
        'billing injoignable - resolution de jeton degradee en mode gratuit',
      );
      return false;
    }
    return res.premium;
  }
}
