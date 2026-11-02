import {
  decodePrincipal,
  encodePrincipal,
  PrincipalDecodeError,
} from './principal.codec';
import { createHmac } from 'crypto';
import { Principal } from './principal.types';

const SECRET = 'x'.repeat(48);

function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: '11111111-2222-3333-4444-555555555555',
    premium: true,
    exp: Math.floor(Date.now() / 1000) + 60,
    origin: 'gateway',
    ...overrides,
  };
}

describe('principal codec', () => {
  it('round-trip un principal', () => {
    const principal = makePrincipal({ role: 'owner', statuses: ['owned'] });
    const decoded = decodePrincipal(encodePrincipal(principal, SECRET), SECRET);
    expect(decoded.userId).toBe(principal.userId);
    expect(decoded.premium).toBe(true);
    expect(decoded.role).toBe('owner');
    expect(decoded.statuses).toEqual(['owned']);
  });

  it('force origin=gateway meme si le payload pretend autre chose', () => {
    // Sans ca, un emetteur pourrait maquiller la provenance d'une identite.
    const raw = encodePrincipal(makePrincipal({ origin: 'jwt' }), SECRET);
    expect(decodePrincipal(raw, SECRET).origin).toBe('gateway');
  });

  it('rejette une signature faite avec un autre secret', () => {
    const raw = encodePrincipal(makePrincipal(), 'y'.repeat(48));
    expect(() => decodePrincipal(raw, SECRET)).toThrow(PrincipalDecodeError);
  });

  it('rejette un payload altere', () => {
    const raw = encodePrincipal(makePrincipal({ premium: false }), SECRET);
    const [payload, sig] = raw.split('.');
    const forged = Buffer.from(
      JSON.stringify(makePrincipal({ premium: true })),
      'utf8',
    ).toString('base64url');
    expect(payload).not.toBe(forged);
    expect(() => decodePrincipal(`${forged}.${sig}`, SECRET)).toThrow(
      PrincipalDecodeError,
    );
  });

  it('rejette un principal expire', () => {
    const raw = encodePrincipal(
      makePrincipal({ exp: Math.floor(Date.now() / 1000) - 1 }),
      SECRET,
    );
    expect(() => decodePrincipal(raw, SECRET)).toThrow(/expired/);
  });

  it('rejette une forme malformee', () => {
    expect(() => decodePrincipal('pas-de-point', SECRET)).toThrow(
      PrincipalDecodeError,
    );
    expect(() => decodePrincipal('.sig', SECRET)).toThrow(PrincipalDecodeError);
  });

  it('rejette un payload valide en signature mais pas en forme', () => {
    const payload = Buffer.from(JSON.stringify({ nope: 1 }), 'utf8').toString(
      'base64url',
    );
    const sig = createHmac('sha256', SECRET)
      .update(payload)
      .digest('base64url');
    expect(() => decodePrincipal(`${payload}.${sig}`, SECRET)).toThrow(
      /invalid payload shape/,
    );
  });
});
