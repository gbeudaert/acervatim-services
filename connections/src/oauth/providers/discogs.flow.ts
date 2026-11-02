import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiCacheService } from '../../common/cache/api-cache.service';
import { HttpClientService } from '../../common/http/http-client.service';
import { OauthCredentialsService, OauthProvider } from '../oauth.service';
import { OAuthFlowProvider } from './flow.types';
import { buildOAuth1Header, OAuth1Credentials } from './oauth1';

const DISCOGS_REQUEST_TOKEN_URL = 'https://api.discogs.com/oauth/request_token';
const DISCOGS_ACCESS_TOKEN_URL = 'https://api.discogs.com/oauth/access_token';
const DISCOGS_AUTHORIZE_BASE = 'https://www.discogs.com/oauth/authorize';

/** Un flux abandonne ne doit pas laisser un secret exploitable. */
const PENDING_TTL_SECONDS = 600;

interface PendingRequestToken {
  userId: string;
  requestTokenSecret: string;
}

/**
 * Flux d'autorisation Discogs (OAuth 1.0a).
 *
 * **Seule la moitie « flux » du `DiscogsAdapter` du monolithe est ici.** Sa moitie
 * « recherche » (`search`, `searchByBarcode`, `fetchDetails`, la file BullMQ, les mappers)
 * a suivi le decoupage vers `search`, qui obtient le jeton par
 * `GET /internal/token/:userId/:provider`. La classe du monolithe implementait a la fois
 * `OAuthFlowProvider` et `SourceAdapter` ; le decoupage ne fait que separer deux
 * responsabilites qui n'avaient en commun que le nom du fournisseur.
 *
 * Discogs est en OAuth 1.0a : pas de refresh, et un **token secret** appaire au jeton
 * d'acces. Il est stocke dans la colonne `refreshTokenEncrypted` - detournement herite du
 * monolithe, documente ici parce qu'il est autrement incomprehensible.
 */
@Injectable()
export class DiscogsFlow implements OAuthFlowProvider, OnModuleInit {
  readonly provider: OauthProvider = 'discogs';

  private readonly logger = new Logger(DiscogsFlow.name);
  private consumerKey?: string;
  private consumerSecret?: string;
  private callbackUrl!: string;

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpClientService,
    private readonly cache: ApiCacheService,
    private readonly creds: OauthCredentialsService,
  ) {}

  onModuleInit(): void {
    this.consumerKey = this.config.get<string>('DISCOGS_CONSUMER_KEY');
    this.consumerSecret = this.config.get<string>('DISCOGS_CONSUMER_SECRET');
    this.callbackUrl = this.config.get<string>('DISCOGS_CALLBACK_URL')!;
  }

  async start(userId: string): Promise<{ authorizeUrl: string }> {
    const consumer = this.requireConsumer();

    const authHeader = buildOAuth1Header(
      'GET',
      DISCOGS_REQUEST_TOKEN_URL,
      consumer,
      { oauth_callback: this.callbackUrl },
    );

    const res = await this.http.request<string>(DISCOGS_REQUEST_TOKEN_URL, {
      method: 'GET',
      headers: { Authorization: authHeader },
    });

    const params = parseFormResponse(res.data);
    const requestToken = params.get('oauth_token');
    const requestTokenSecret = params.get('oauth_token_secret');
    if (!requestToken || !requestTokenSecret) {
      throw new BadGatewayException('discogs: invalid request_token response');
    }

    // Le callback n'est pas authentifie : cette ligne est le seul lien entre le navigateur
    // qui revient de Discogs et l'utilisateur qui a lance le flux.
    await this.cache.set<PendingRequestToken>(
      pendingKey(requestToken),
      { userId, requestTokenSecret },
      PENDING_TTL_SECONDS,
    );

    return {
      authorizeUrl: `${DISCOGS_AUTHORIZE_BASE}?oauth_token=${encodeURIComponent(
        requestToken,
      )}`,
    };
  }

  async callback(query: Record<string, string>): Promise<{ userId: string }> {
    const consumer = this.requireConsumer();
    const oauthToken = query.oauth_token;
    const oauthVerifier = query.oauth_verifier;
    if (!oauthToken || !oauthVerifier) {
      throw new BadRequestException(
        'discogs: oauth_token + oauth_verifier required',
      );
    }

    const pending = await this.cache.get<PendingRequestToken>(
      pendingKey(oauthToken),
    );
    if (!pending) {
      throw new BadRequestException('discogs: invalid or expired oauth flow');
    }

    const authHeader = buildOAuth1Header(
      'POST',
      DISCOGS_ACCESS_TOKEN_URL,
      {
        ...consumer,
        tokenKey: oauthToken,
        tokenSecret: pending.requestTokenSecret,
      },
      { oauth_verifier: oauthVerifier },
    );

    const res = await this.http.request<string>(DISCOGS_ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: { Authorization: authHeader },
    });

    const params = parseFormResponse(res.data);
    const accessToken = params.get('oauth_token');
    const accessTokenSecret = params.get('oauth_token_secret');
    if (!accessToken || !accessTokenSecret) {
      throw new BadGatewayException('discogs: invalid access_token response');
    }

    // OAuth 1.0a n'a pas de refresh : le champ porte le token secret. Voir le JSDoc de classe.
    await this.creds.store(pending.userId, 'discogs', {
      accessToken,
      refreshToken: accessTokenSecret,
      expiresAtMs: 0,
      scopes: [],
    });

    // Le pending est consomme : le laisser vivre jusqu'a son TTL laisserait un secret
    // utilisable pour rejouer l'echange.
    await this.cache.delete(pendingKey(oauthToken));

    return { userId: pending.userId };
  }

  private requireConsumer(): OAuth1Credentials {
    if (!this.consumerKey || !this.consumerSecret) {
      this.logger.error(
        'DISCOGS_CONSUMER_KEY / DISCOGS_CONSUMER_SECRET not configured',
      );
      throw new ServiceUnavailableException('discogs: not configured');
    }
    return {
      consumerKey: this.consumerKey,
      consumerSecret: this.consumerSecret,
    };
  }
}

function pendingKey(requestToken: string): string {
  return `oauth-discogs-pending:${requestToken}`;
}

/** Discogs repond en `application/x-www-form-urlencoded`, pas en JSON. */
function parseFormResponse(body: string): URLSearchParams {
  return new URLSearchParams(body);
}
