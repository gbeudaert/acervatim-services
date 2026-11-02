import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { ApiCacheService } from '../../common/cache/api-cache.service';
import { HttpClientService } from '../../common/http/http-client.service';
import { OauthCredentialsService, OauthProvider } from '../oauth.service';
import { OAuthFlowProvider } from './flow.types';
import { codeChallengePlain, generateCodeVerifier } from './pkce';

const MAL_AUTHORIZE_URL = 'https://myanimelist.net/v1/oauth2/authorize';
const MAL_TOKEN_URL = 'https://myanimelist.net/v1/oauth2/token';
const PENDING_TTL_SECONDS = 600;

interface PendingState {
  userId: string;
  codeVerifier: string;
}

interface MalTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

/**
 * Flux d'autorisation MyAnimeList (OAuth 2.0 + PKCE).
 *
 * **Seule la moitie « flux » du `MalAdapter` du monolithe est ici** ; sa moitie « recherche »
 * - de loin la plus grosse, avec le pivot BnF / Google Books / MangaDex - a suivi le
 * decoupage vers `search`.
 *
 * MAL utilise `code_challenge_method=plain`, c'est-a-dire que le challenge **est** le
 * verifier. C'est non standard, mais c'est la documentation officielle de MAL ; utiliser
 * S256 fait echouer l'echange avec une erreur generique.
 */
@Injectable()
export class MalFlow implements OAuthFlowProvider, OnModuleInit {
  readonly provider: OauthProvider = 'mal';

  private readonly logger = new Logger(MalFlow.name);
  private clientId?: string;
  private clientSecret?: string;
  private callbackUrl!: string;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpClientService,
    private readonly cache: ApiCacheService,
    private readonly creds: OauthCredentialsService,
  ) {}

  onModuleInit(): void {
    this.clientId = this.config.get<string>('MAL_CLIENT_ID');
    this.clientSecret = this.config.get<string>('MAL_CLIENT_SECRET');
    this.callbackUrl = this.config.get<string>('MAL_CALLBACK_URL')!;
  }

  async start(userId: string): Promise<{ authorizeUrl: string }> {
    const { clientId } = this.requireConfig();

    const codeVerifier = generateCodeVerifier();
    // MAL : challenge === verifier. Voir le JSDoc de classe.
    const codeChallenge = codeChallengePlain(codeVerifier);
    const state = randomBytes(32).toString('hex');

    await this.cache.set<PendingState>(
      pendingKey(state),
      { userId, codeVerifier },
      PENDING_TTL_SECONDS,
    );

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      code_challenge: codeChallenge,
      code_challenge_method: 'plain',
      state,
      redirect_uri: this.callbackUrl,
    });

    return { authorizeUrl: `${MAL_AUTHORIZE_URL}?${params.toString()}` };
  }

  async callback(query: Record<string, string>): Promise<{ userId: string }> {
    const { clientId, clientSecret } = this.requireConfig();
    const code = query.code;
    const state = query.state;
    if (!code || !state) {
      throw new BadRequestException('mal: code + state required');
    }

    const pending = await this.cache.get<PendingState>(pendingKey(state));
    if (!pending) {
      throw new BadRequestException('mal: invalid or expired oauth flow');
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: pending.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: this.callbackUrl,
    }).toString();

    const res = await this.http.request<MalTokenResponse>(MAL_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    const token = res.data;
    if (!token.access_token) {
      throw new BadGatewayException('mal: invalid token response');
    }
    const expiresAtMs = token.expires_in
      ? Date.now() + token.expires_in * 1000
      : 0;

    await this.creds.store(pending.userId, 'mal', {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAtMs,
      scopes: [],
    });

    await this.cache.delete(pendingKey(state));

    return { userId: pending.userId };
  }

  private requireConfig(): { clientId: string; clientSecret: string } {
    if (!this.clientId || !this.clientSecret) {
      this.logger.error('MAL_CLIENT_ID / MAL_CLIENT_SECRET not configured');
      throw new ServiceUnavailableException('mal: not configured');
    }
    return { clientId: this.clientId, clientSecret: this.clientSecret };
  }
}

function pendingKey(state: string): string {
  return `oauth-mal-pending:${state}`;
}
