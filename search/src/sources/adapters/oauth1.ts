import { createHmac, randomBytes } from 'crypto';

/**
 * Signature OAuth 1.0a - RFC 5849. Helper pur, sans etat.
 *
 * **Ce fichier existe en double**, ici et dans `connections/src/oauth/providers/oauth1.ts`.
 * Ce n'est pas un oubli : `connections` signe les echanges du **flux** (request token, access
 * token), `search` signe les **appels de catalogue**, et l'invariant du 1 de
 * architecture-microservices.md interdit une dependance directe entre deux `apps/`. Quatre-vingts
 * lignes de RFC figee, dupliquees, valent mieux qu'un couplage qui rendrait le decoupage
 * cosmetique - la specification, elle, ne bougera pas.
 */

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  /** Optionnel : présent dès qu'on a un request token ou access token. */
  tokenKey?: string;
  /** Optionnel : appairé avec tokenKey, sert dans la signing key. */
  tokenSecret?: string;
}

export type OAuth1Method = 'GET' | 'POST';

/**
 * RFC 3986 percent-encoding. `encodeURIComponent` natif n'encode pas `! * ' ( )` qui DOIVENT l'être
 * pour OAuth 1.0a — sinon les signatures fail avec un message générique côté Discogs.
 */
export function percentEncode(str: string): string {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

/**
 * Génère la valeur du header `Authorization` pour un appel OAuth 1.0a.
 * `extraParams` couvre les query/body params + les params hors `oauth_*` (ex: `oauth_callback`,
 * `oauth_verifier` que Discogs attend dans la signature mais qui ne sont pas des paramètres
 * "OAuth standard" qu'on génère systématiquement).
 *
 * `deps` est optionnel et permet d'injecter nonce/timestamp en test (sinon non déterministe).
 */
export function buildOAuth1Header(
  method: OAuth1Method,
  url: string,
  creds: OAuth1Credentials,
  extraParams: Record<string, string> = {},
  deps: {
    nonce?: () => string;
    timestamp?: () => string;
  } = {},
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: deps.nonce ? deps.nonce() : randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: deps.timestamp
      ? deps.timestamp()
      : Math.floor(Date.now() / 1000).toString(),
    oauth_version: '1.0',
  };

  if (creds.tokenKey) {
    oauthParams.oauth_token = creds.tokenKey;
  }

  const allParams = { ...oauthParams, ...extraParams };
  const paramString = Object.keys(allParams)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(allParams[k])}`)
    .join('&');

  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(paramString),
  ].join('&');

  const signingKey = `${percentEncode(creds.consumerSecret)}&${percentEncode(
    creds.tokenSecret ?? '',
  )}`;

  oauthParams.oauth_signature = createHmac('sha1', signingKey)
    .update(baseString)
    .digest('base64');

  const headerParts = Object.entries(oauthParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`);

  return `OAuth ${headerParts.join(', ')}`;
}
