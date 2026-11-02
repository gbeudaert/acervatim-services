import { createHmac, timingSafeEqual } from 'crypto';
import { Principal } from './principal.types';

/**
 * Encodage de `X-Acervatim-Principal` : `<base64url(json)>.<base64url(hmac-sha256)>`.
 *
 * Compact et sans dependance (pas de JWT : ce jeton ne quitte jamais le reseau interne et
 * n'a ni audience, ni rotation de cle publique a gerer). La signature couvre l'octet-a-octet
 * du payload encode, pas le JSON re-serialise - une re-serialisation differente cote gateway
 * invaliderait sinon une signature pourtant legitime.
 */
export function encodePrincipal(principal: Principal, secret: string): string {
  const payload = Buffer.from(JSON.stringify(principal), 'utf8').toString(
    'base64url',
  );
  return `${payload}.${sign(payload, secret)}`;
}

export class PrincipalDecodeError extends Error {}

export function decodePrincipal(raw: string, secret: string): Principal {
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) {
    throw new PrincipalDecodeError('malformed principal');
  }
  const payload = raw.slice(0, dot);
  const provided = raw.slice(dot + 1);

  const expected = sign(payload, secret);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Comparaison a temps constant. `timingSafeEqual` exige des longueurs egales,
  // d'ou le test de longueur prealable (qui ne fuit que la longueur, publique).
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new PrincipalDecodeError('bad signature');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new PrincipalDecodeError('unparsable payload');
  }
  if (!isPrincipalShape(parsed)) {
    throw new PrincipalDecodeError('invalid payload shape');
  }
  if (parsed.exp * 1000 <= Date.now()) {
    throw new PrincipalDecodeError('expired principal');
  }
  return { ...parsed, origin: 'gateway' };
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function isPrincipalShape(v: unknown): v is Principal {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.userId === 'string' &&
    p.userId.length > 0 &&
    typeof p.premium === 'boolean' &&
    typeof p.exp === 'number'
  );
}
