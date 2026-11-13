import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import {
  HttpClientError,
  HttpClientService,
  HttpRetryableError,
} from '../../common/http/http-client.service';
import {
  GameUpcRecordedVote,
  GameUpcUpcInfo,
  WireErrorSchema,
  WireUpcInfoSchema,
  WireVoteSchema,
  toUpcInfo,
} from './gameupc.types';

/** Jeton d'injection de {@link GameUpcClient} : les workers et le service n'en connaissent que l'interface. */
export const GAMEUPC_CLIENT = Symbol('GAMEUPC_CLIENT');

export interface GameUpcLookupOptions {
  /** Termes saisis par l'utilisateur ; absents = heuristique GameUPC (nom déduit d'autres bases). */
  search?: string | null;
  mode?: 'speed' | 'quality';
}

export interface GameUpcVoteRequest {
  upc: string;
  bggId: number;
  /** Version BGG (édition, langue) ; `null` = vote sur le jeu seul. */
  versionId: number | null;
  /** Pseudonyme stable de l'utilisateur, ≥ 8 caractères (sinon `400`). */
  voterId: string;
}

/**
 * Port vers GameUPC. Pas de cache, pas de débit, pas de retry différé : ce sont les files
 * (`GameUpcLookupProcessor`, `GameUpcFeedbackProcessor`) qui les portent. Un client ne fait QUE
 * l'appel et la traduction des réponses et des erreurs.
 */
export interface GameUpcClient {
  /** `false` sans clé : rien ne part, le service répond `unavailable`. */
  readonly enabled: boolean;
  lookup(upc: string, opts?: GameUpcLookupOptions): Promise<GameUpcUpcInfo>;
  /**
   * Vote d'un utilisateur. GameUPC garde **un vote par (code, utilisateur)** : revoter remplace le
   * précédent, renvoyer le même ne change rien (mesuré sur le serveur de test). Renvoie l'état du
   * code après le vote.
   */
  vote(vote: GameUpcVoteRequest): Promise<GameUpcUpcInfo>;
  /** Vote déjà enregistré pour ce votant, `null` s'il n'a pas voté (`404`). */
  recordedVote(
    upc: string,
    voterId: string,
  ): Promise<GameUpcRecordedVote | null>;
}

export type GameUpcErrorKind =
  | 'disabled'
  | 'rate_limited'
  | 'unavailable'
  | 'unauthorized'
  | 'rejected'
  | 'not_found'
  | 'invalid_response';

export class GameUpcError extends Error {
  constructor(
    readonly kind: GameUpcErrorKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'GameUpcError';
  }

  /** Seuls `429` et l'indisponibilité se retentent : un `400` ou un `403` le seront à l'identique. */
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'unavailable';
  }
}

/**
 * Tentatives HTTP d'une consultation : une seconde chance courte (backoff `HttpClientService`),
 * l'utilisateur attend. Le vote, lui, n'en a qu'une : son retry est celui de la file, en minutes.
 */
const LOOKUP_ATTEMPTS = 2;
const VOTE_ATTEMPTS = 1;

const DEFAULT_BASE_URL = 'https://api.gameupc.com/test';

/** Implémentation HTTP de {@link GameUpcClient}, clé `x-api-key` injectée ici et nulle part ailleurs. */
@Injectable()
export class GameUpcHttpClient implements GameUpcClient {
  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpClientService,
  ) {}

  get enabled(): boolean {
    return Boolean(this.apiKey());
  }

  async lookup(
    upc: string,
    opts: GameUpcLookupOptions = {},
  ): Promise<GameUpcUpcInfo> {
    const params = new URLSearchParams();
    if (opts.search) params.set('search', opts.search);
    if (opts.mode) params.set('search_mode', opts.mode);
    const qs = params.toString();
    const data = await this.call(
      'GET',
      `/upc/${encodeURIComponent(upc)}${qs ? `?${qs}` : ''}`,
      undefined,
      LOOKUP_ATTEMPTS,
    );
    return toUpcInfo(parse(WireUpcInfoSchema, data));
  }

  async vote(vote: GameUpcVoteRequest): Promise<GameUpcUpcInfo> {
    // Chemin reconstruit, pas repris de `update_url` : celui-ci porte l'environnement de la
    // consultation (`/test/`), qui n'est pas forcément celui de la clé configurée.
    const version = vote.versionId ? `/version/${vote.versionId}` : '';
    const data = await this.call(
      'POST',
      `/upc/${encodeURIComponent(vote.upc)}/bgg_id/${vote.bggId}${version}`,
      { user_id: vote.voterId },
      VOTE_ATTEMPTS,
    );
    return toUpcInfo(parse(WireUpcInfoSchema, data));
  }

  async recordedVote(
    upc: string,
    voterId: string,
  ): Promise<GameUpcRecordedVote | null> {
    let data: unknown;
    try {
      data = await this.call(
        'GET',
        `/upc/${encodeURIComponent(upc)}/user_id/${encodeURIComponent(voterId)}`,
        undefined,
        VOTE_ATTEMPTS,
      );
    } catch (err) {
      if (err instanceof GameUpcError && err.kind === 'not_found') return null;
      throw err;
    }
    const v = parse(WireVoteSchema, data);
    return {
      upc: v.upc,
      bggId: v.bgg_id,
      versionId: v.bgg_version ? v.bgg_version : null,
      // Sans fuseau chez GameUPC ; ses en-têtes `Date` sont en GMT.
      recordedAt: /[zZ]|[+-]\d\d:?\d\d$/.test(v.date) ? v.date : `${v.date}Z`,
    };
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | undefined,
    maxAttempts: number,
  ): Promise<unknown> {
    const key = this.apiKey();
    if (!key) throw new GameUpcError('disabled', 'GAMEUPC_API_KEY is not set');

    try {
      const res = await this.http.request<unknown>(`${this.baseUrl()}${path}`, {
        method,
        headers: {
          'x-api-key': key,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        maxAttempts,
      });
      return res.data;
    } catch (err) {
      throw toGameUpcError(err);
    }
  }

  private apiKey(): string | undefined {
    return this.config.get<string>('GAMEUPC_API_KEY') || undefined;
  }

  private baseUrl(): string {
    return (
      this.config.get<string>('GAMEUPC_BASE_URL') ?? DEFAULT_BASE_URL
    ).replace(/\/+$/, '');
  }
}

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const res = schema.safeParse(data);
  if (res.success) return res.data;
  // Un 2xx peut porter `{"status":"error"}` : le traiter comme un refus, pas comme une panne.
  const err = WireErrorSchema.safeParse(data);
  if (err.success && err.data.status === 'error') {
    throw new GameUpcError('rejected', err.data.message ?? 'error');
  }
  throw new GameUpcError(
    'invalid_response',
    `unexpected GameUPC payload: ${res.error.issues[0]?.message ?? 'unknown'}`,
  );
}

function toGameUpcError(err: unknown): GameUpcError {
  if (err instanceof GameUpcError) return err;
  if (err instanceof HttpClientError) {
    const body = WireErrorSchema.safeParse(err.body);
    const message =
      (body.success ? body.data.message : undefined) ?? err.message;
    if (err.status === 401 || err.status === 403) {
      return new GameUpcError('unauthorized', message);
    }
    if (err.status === 404) return new GameUpcError('not_found', message);
    return new GameUpcError('rejected', message);
  }
  if (err instanceof BadGatewayException) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof HttpRetryableError && cause.status === 429) {
      return new GameUpcError(
        'rate_limited',
        'GameUPC overloaded (429)',
        cause.retryAfterMs,
      );
    }
  }
  return new GameUpcError(
    'unavailable',
    err instanceof Error ? err.message : 'GameUPC unavailable',
  );
}
