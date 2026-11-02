import { BadRequestException, Injectable } from '@nestjs/common';
import { OauthCredentialsService, OauthProvider } from '../oauth/oauth.service';

/**
 * Sources dont la cle se **colle** au lieu de se connecter par OAuth.
 *
 * La liste blanche n'est pas cosmetique : sans elle, `PUT /v1/sources/:provider/token`
 * accepterait n'importe quel nom de provider et remplirait `oauth_credentials` de lignes
 * qu'aucun adapter ne lira jamais - au mieux du bruit, au pire une ligne `discogs` posee a
 * la main qui court-circuiterait le flux OAuth et casserait la signature 1.0a (qui a besoin
 * du token secret, qu'une saisie manuelle ne fournit pas).
 */
const BYOT_PROVIDERS = new Set<OauthProvider>(['tmdb']);

/**
 * Sources a flux OAuth : elles se connectent par `/v1/oauth/:provider/start`, jamais par une
 * saisie de cle. Refusees explicitement plutot que silencieusement pour que l'app puisse
 * afficher le bon parcours.
 */
const OAUTH_PROVIDERS = new Set<OauthProvider>(['discogs', 'mal']);

@Injectable()
export class SourcesService {
  constructor(private readonly credentials: OauthCredentialsService) {}

  async list(userId: string): Promise<{
    data: Array<{ provider: string; kind: 'byot' | 'oauth'; connected: boolean }>;
  }> {
    const connected = new Set(
      (await this.credentials.listConnected(userId)).map((c) => c.provider),
    );
    const rows = [
      ...[...BYOT_PROVIDERS].map((p) => ({ provider: p, kind: 'byot' as const })),
      ...[...OAUTH_PROVIDERS].map((p) => ({
        provider: p,
        kind: 'oauth' as const,
      })),
    ];
    return {
      data: rows.map((r) => ({ ...r, connected: connected.has(r.provider) })),
    };
  }

  async setToken(
    userId: string,
    provider: string,
    token: string,
  ): Promise<void> {
    await this.credentials.store(userId, this.requireByot(provider), {
      accessToken: token,
      // Une cle personnelle n'expire pas d'elle-meme : 0 = jamais.
      expiresAtMs: 0,
      scopes: [],
    });
  }

  async removeToken(userId: string, provider: string): Promise<void> {
    await this.credentials.remove(userId, this.requireByot(provider));
  }

  private requireByot(provider: string): OauthProvider {
    const p = provider as OauthProvider;
    if (BYOT_PROVIDERS.has(p)) return p;
    if (OAUTH_PROVIDERS.has(p)) {
      throw new BadRequestException(
        `source "${provider}" se connecte par OAuth : utiliser GET /v1/oauth/${provider}/start`,
      );
    }
    throw new BadRequestException(`unknown source "${provider}"`);
  }
}
