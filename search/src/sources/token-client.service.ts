import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalTokenResolution } from '../common/internal/contracts';
import { InternalClientService } from '../common/internal/internal-client.service';

/** Jetons personnels d'un utilisateur, tels que `connections` les rend. */
export interface DecryptedCredentials {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms ; 0 = jamais (OAuth 1.0a et cles personnelles). */
  expiresAtMs: number;
  scopes: string[];
}

/**
 * Decision de resolution d'un jeton, cote consommateur.
 *  - `user`     : jetons personnels -> on les utilise ;
 *  - `fallback` : premium -> **notre** cle serveur pour cette source ;
 *  - `none`     : mode degrade (cache), puis 403 actionnable.
 */
export type TokenResolution =
  | { source: 'user'; credentials: DecryptedCredentials }
  | { source: 'fallback' }
  | { source: 'none' };

/**
 * Remplace le `TokenResolverService` que le monolithe avait en memoire : c'est desormais un
 * appel a `connections` (`GET /internal/token/:userId/:provider`).
 *
 * La forme du resultat est **inchangee** a dessein. Les adapters et les workers du monolithe
 * font tous `switch (resolution.source)` ; changer ce type aurait impose de reecrire une
 * dizaine de branches pour un decoupage qui n'en demande aucune.
 *
 * `connections` injoignable -> `none`, c'est-a-dire mode degrade. C'est le seul repli sur :
 * supposer `fallback` consommerait la cle serveur Acervatim pour un utilisateur peut-etre
 * gratuit, et supposer `user` n'a aucun sens sans jeton. L'utilisateur voit alors le cache,
 * puis un `403 source-token-required` - actionnable, meme si la cause reelle est une panne.
 */
@Injectable()
export class TokenClientService {
  private readonly logger = new Logger(TokenClientService.name);

  constructor(
    private readonly internal: InternalClientService,
    private readonly config: ConfigService,
  ) {}

  async resolve(userId: string, provider: string): Promise<TokenResolution> {
    const baseUrl = this.config.get<string>('CONNECTIONS_BASE_URL');
    if (!baseUrl) {
      // Sans `connections`, aucun jeton personnel n'est connaissable : mode degrade.
      return { source: 'none' };
    }

    const res = await this.internal.tryRequest<InternalTokenResolution>(
      baseUrl,
      `/internal/token/${encodeURIComponent(userId)}/${encodeURIComponent(provider)}`,
    );
    if (!res) {
      this.logger.warn(
        `connections injoignable - ${provider} degrade en mode cache`,
      );
      return { source: 'none' };
    }

    if (res.source === 'user' && res.credentials) {
      return { source: 'user', credentials: res.credentials };
    }
    return { source: res.source === 'fallback' ? 'fallback' : 'none' };
  }
}
