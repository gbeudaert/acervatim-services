import {
  BadGatewayException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Client HTTP des routes `/internal/*` entre services.
 *
 * Volontairement distinct de `HttpClientService`, qui vise l'exterieur : les contraintes
 * sont inverses. Ici le reseau est local et fiable, donc **timeout court** (2 s) et
 * **une seule tentative** par defaut - un service voisin lent doit se voir tout de suite,
 * pas apres trois backoffs qui transformeraient une panne franche en latence diffuse sur
 * le chemin chaud. La ou un retour degrade est acceptable, l'appelant passe par
 * {@link tryRequest} et decide lui-meme.
 *
 * Authentification par `INTERNAL_SERVICE_TOKEN` : aucune de ces routes n'est exposee par
 * le gateway, et le secret ne quitte jamais le reseau interne.
 */

export interface InternalRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  timeoutMs?: number;
  /** Id de correlation de la requete entrante, propage pour tracer une chaine complete. */
  requestId?: string;
}

const DEFAULT_TIMEOUT_MS = 2_000;

/** Erreur d'un appel interne dont le statut est connu (le voisin a repondu). */
export class InternalCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

@Injectable()
export class InternalClientService implements OnModuleInit {
  private readonly logger = new Logger(InternalClientService.name);
  private token = '';

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.token = this.config.get<string>('INTERNAL_SERVICE_TOKEN') ?? '';
    if (!this.token) {
      this.logger.warn(
        'INTERNAL_SERVICE_TOKEN absent - les appels /internal/* partiront sans authentification',
      );
    }
  }

  /**
   * Appel interne strict : leve `InternalCallError` sur reponse 4xx/5xx du voisin, et
   * `BadGatewayException` si le voisin n'a pas repondu du tout (reseau, timeout).
   */
  async request<T>(
    baseUrl: string,
    path: string,
    opts: InternalRequestOptions = {},
  ): Promise<T> {
    const url = `${baseUrl.replace(/\/+$/, '')}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          ...(opts.requestId ? { 'X-Request-Id': opts.requestId } : {}),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'network error';
      this.logger.warn(`internal: ${redact(url)} injoignable (${msg})`);
      throw new BadGatewayException(`internal call failed: ${redact(url)}`);
    } finally {
      clearTimeout(timer);
    }

    const payload = await safeBody(res);
    if (res.status >= 400) {
      throw new InternalCallError(
        `internal ${res.status} on ${redact(url)}`,
        res.status,
        payload,
      );
    }
    return payload as T;
  }

  /**
   * Variante tolerante : renvoie `null` au lieu de lever. A n'utiliser que la ou un
   * resultat manquant a une **semantique definie** cote appelant - par exemple un compte
   * d'items indisponible qui s'affiche absent plutot que de faire echouer toute la liste.
   * Ne jamais s'en servir pour une decision d'autorisation : un `null` y deviendrait un
   * « acces refuse » silencieux, ou pire, un acces accorde par defaut.
   */
  async tryRequest<T>(
    baseUrl: string,
    path: string,
    opts: InternalRequestOptions = {},
  ): Promise<T | null> {
    try {
      return await this.request<T>(baseUrl, path, opts);
    } catch (err) {
      const detail =
        err instanceof InternalCallError
          ? `status=${err.status}`
          : (err as Error).message;
      this.logger.warn(`internal (tolere): ${path} -> ${detail}`);
      return null;
    }
  }
}

async function safeBody(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('json')) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  return await res.text();
}

/** Retire la query string : elle peut porter un identifiant utilisateur. */
function redact(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}
