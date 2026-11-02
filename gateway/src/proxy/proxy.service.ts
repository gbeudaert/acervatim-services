import {
  BadGatewayException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { PRINCIPAL_HEADER } from '../common/guards/principal.types';

/**
 * En-tetes que le gateway retransmet vers l'aval. Liste **blanche** : tout le reste est
 * supprime. En particulier `Authorization`, qui porte le JWT de l'utilisateur - le
 * transmettre ferait que chaque service pourrait le re-verifier, ou pire, s'en servir
 * ailleurs. L'identite passe par le principal signe, et par lui seul (3.6).
 */
const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'accept-language'];

/**
 * En-tetes de reponse retransmis vers le client. `Content-Disposition` en fait partie :
 * sans lui, `GET /v1/me/export` cesserait d'etre un telechargement nomme.
 */
const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'content-disposition',
  'cache-control',
  'etag',
  'last-modified',
  'location',
  'retry-after',
  'x-request-id',
];

/**
 * Transmission d'une requete vers un service et de sa reponse vers le client.
 *
 * Le corps est relaye **tel quel** dans les deux sens, y compris les Problem Details : c'est
 * la condition posee au 5 de architecture-microservices.md - l'app Android n'est pas
 * modifiee, donc elle doit continuer de voir exactement les memes URI `type`, les memes
 * codes et la meme pagination qu'avec le monolithe. Le gateway n'a rien a reecrire.
 */
@Injectable()
export class ProxyService implements OnModuleInit {
  private readonly logger = new Logger(ProxyService.name);
  private timeoutMs = 30_000;
  private userAgent = 'Acervatim-Gateway/0.1';

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.timeoutMs = this.config.get<number>('PROXY_TIMEOUT_MS', 30_000);
    this.userAgent = this.config.get<string>(
      'HTTP_USER_AGENT',
      this.userAgent,
    );
  }

  /** Appelle un service et renvoie sa reponse brute, sans l'ecrire au client. */
  async call(
    baseUrl: string,
    req: Request,
    principalHeader: string | undefined,
    pathOverride?: string,
    opts: { forwardAuthorization?: boolean } = {},
  ): Promise<{ status: number; headers: Headers; body: Buffer }> {
    const path = pathOverride ?? req.originalUrl;
    const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
    };
    for (const name of FORWARD_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    if (principalHeader) headers[PRINCIPAL_HEADER] = principalHeader;
    if (req.requestId) headers['x-request-id'] = req.requestId;
    // Uniquement quand la regle de route le declare : voir `RouteRule.forwardAuthorization`.
    if (opts.forwardAuthorization && typeof req.headers.authorization === 'string') {
      headers.authorization = req.headers.authorization;
    }

    const hasBody = !['GET', 'HEAD'].includes(req.method.toUpperCase());
    let body: string | undefined;
    if (hasBody && req.body !== undefined && req.body !== null) {
      // Le corps a ete parse par `express.json()` en amont : on le re-serialise. Toutes
      // les routes du contrat V1 sont en JSON, aucune n'est binaire ni multipart.
      body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      headers['content-type'] = headers['content-type'] ?? 'application/json';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: globalThis.Response;
    try {
      res = await fetch(url, {
        method: req.method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      this.logger.warn(
        `proxy: ${req.method} ${redact(path)} -> ${redact(baseUrl)} ${aborted ? 'timeout' : 'injoignable'}`,
      );
      // Deux codes distincts, parce qu'ils appellent deux reactions differentes cote
      // client : un 504 se retente, un 502 signale que l'amont ne repond pas du tout.
      throw aborted
        ? new GatewayTimeoutException('upstream timeout')
        : new BadGatewayException('upstream unavailable');
    } finally {
      clearTimeout(timer);
    }

    return {
      status: res.status,
      headers: res.headers,
      body: Buffer.from(await res.arrayBuffer()),
    };
  }

  /** Appelle un service et ecrit sa reponse au client, telle quelle. */
  async forward(
    baseUrl: string,
    req: Request,
    res: Response,
    principalHeader: string | undefined,
    pathOverride?: string,
    opts: { forwardAuthorization?: boolean } = {},
  ): Promise<void> {
    const upstream = await this.call(
      baseUrl,
      req,
      principalHeader,
      pathOverride,
      opts,
    );
    for (const name of FORWARD_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    // Le gateway garde SON id de correlation : celui de l'aval en est derive, et deux
    // valeurs differentes rendraient une trace impossible a recoudre.
    if (req.requestId) res.setHeader('X-Request-Id', req.requestId);
    res.status(upstream.status).send(upstream.body);
  }

  /** Deserialise une reponse amont en JSON - utilise par le scatter-gather. */
  parseJson<T>(body: Buffer): T {
    return JSON.parse(body.toString('utf8')) as T;
  }
}

/** Retire la query string : elle peut porter un terme de recherche ou un identifiant. */
function redact(value: string): string {
  const q = value.indexOf('?');
  return q === -1 ? value : value.slice(0, q);
}
