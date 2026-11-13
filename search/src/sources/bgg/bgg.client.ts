import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HttpClientError,
  HttpClientService,
  HttpRetryableError,
} from '../../common/http/http-client.service';
import { parseThing } from './bgg-thing.parser';
import { BggThing } from './bgg.types';

export const BGG_CLIENT = Symbol('BGG_CLIENT');

/** Port vers l'API XML de BGG. Comme `GameUpcClient` : l'appel seul, ni cache ni débit. */
export interface BggClient {
  /** `false` sans `BGG_API_TOKEN` : licence non obtenue, aucun appel ne part. */
  readonly enabled: boolean;
  /** Fiche d'un jeu, `null` si BGG ne connaît pas l'id. */
  thing(bggId: number): Promise<BggThing | null>;
}

export type BggErrorKind =
  'disabled' | 'rate_limited' | 'unavailable' | 'unauthorized' | 'rejected';

export class BggError extends Error {
  constructor(
    readonly kind: BggErrorKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'BggError';
  }
}

const DEFAULT_BASE_URL = 'https://boardgamegeek.com/xmlapi2';

@Injectable()
export class BggHttpClient implements BggClient {
  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpClientService,
  ) {}

  get enabled(): boolean {
    return Boolean(this.token());
  }

  async thing(bggId: number): Promise<BggThing | null> {
    const token = this.token();
    if (!token) throw new BggError('disabled', 'BGG_API_TOKEN is not set');

    let res;
    try {
      res = await this.http.request<unknown>(
        `${this.baseUrl()}/thing?id=${bggId}&stats=1`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/xml',
          },
          // Une seule tentative : un retry transport à 250 ms violerait la règle des 2 s. Le
          // retry est celui de la file, qui passe à nouveau par le limiter.
          maxAttempts: 1,
        },
      );
    } catch (err) {
      throw toBggError(err);
    }
    // `202` : BGG a mis la demande en file de son côté, la réponse viendra plus tard.
    if (res.status === 202 || typeof res.data !== 'string') {
      throw new BggError(
        'unavailable',
        `BGG answered ${res.status}, retry later`,
      );
    }
    return parseThing(res.data, bggId);
  }

  private token(): string | undefined {
    return this.config.get<string>('BGG_API_TOKEN') || undefined;
  }

  private baseUrl(): string {
    return (
      this.config.get<string>('BGG_BASE_URL') ?? DEFAULT_BASE_URL
    ).replace(/\/+$/, '');
  }
}

function toBggError(err: unknown): BggError {
  if (err instanceof HttpClientError) {
    return err.status === 401 || err.status === 403
      ? new BggError('unauthorized', `BGG refused the token (${err.status})`)
      : new BggError('rejected', `BGG rejected the request (${err.status})`);
  }
  if (err instanceof BadGatewayException) {
    const cause = (err as { cause?: unknown }).cause;
    // BGG signale son débit par `429`, et historiquement par `503` : les deux mettent la file en pause.
    if (
      cause instanceof HttpRetryableError &&
      (cause.status === 429 || cause.status === 503)
    ) {
      return new BggError(
        'rate_limited',
        `BGG throttled (${cause.status})`,
        cause.retryAfterMs,
      );
    }
  }
  return new BggError(
    'unavailable',
    err instanceof Error ? err.message : 'BGG unavailable',
  );
}
