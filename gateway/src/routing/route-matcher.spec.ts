import { allowedMethods, matchRoute, pathExists } from './route-matcher';
import { forwardsAuthorization, ROUTE_TABLE } from './route-table';

describe('matchRoute', () => {
  it('route une collection vers le catalog par reference', () => {
    const m = matchRoute('GET', '/v1/collections/11111111-2222-3333-4444-555555555555');
    expect(m?.rule.target).toEqual({
      kind: 'catalog:ref',
      via: 'collection',
      param: 'id',
    });
    expect(m?.params.id).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('distingue la lecture de l ecriture sur la meme URL', () => {
    expect(matchRoute('GET', '/v1/items/abc')?.rule.write).toBeUndefined();
    expect(matchRoute('PATCH', '/v1/items/abc')?.rule.write).toBe(true);
  });

  // Le piege de l'ordre de declaration : ces deux segments litteraux doivent gagner
  // contre `:id`, sinon ils partiraient au registre comme des identifiants.
  it('fait passer /shares/received et /shares/redeem avant /shares/:id', () => {
    expect(matchRoute('GET', '/v1/shares/received')?.rule.pattern).toBe(
      '/v1/shares/received',
    );
    expect(matchRoute('POST', '/v1/shares/redeem')?.rule.pattern).toBe(
      '/v1/shares/redeem',
    );
    expect(matchRoute('DELETE', '/v1/shares/xyz')?.rule.pattern).toBe(
      '/v1/shares/:id',
    );
  });

  it('prefere /search/cover a /search', () => {
    expect(matchRoute('GET', '/v1/search/cover')?.rule.pattern).toBe(
      '/v1/search/cover',
    );
    expect(matchRoute('GET', '/v1/search')?.rule.pattern).toBe('/v1/search');
  });

  it('route le rattrapage manga vers search, premium du requerant sur la lecture', () => {
    expect(matchRoute('GET', '/v1/search/editions')?.rule.pattern).toBe(
      '/v1/search/editions',
    );
    const updates = matchRoute('GET', '/v1/series-updates')?.rule;
    expect(updates?.target).toEqual({ kind: 'service', service: 'search' });
    expect(updates?.premium).toBe('requester');
    const run = matchRoute('POST', '/v1/admin/edition-watch/run')?.rule;
    expect(run?.target).toEqual({ kind: 'service', service: 'search' });
    expect(run?.auth).toBe('admin');
  });

  it('ignore la query string', () => {
    expect(matchRoute('GET', '/v1/collections?type[in]=manga')?.rule.target.kind).toBe(
      'catalog:scatter',
    );
  });

  it('refuse un segment vide comme identifiant', () => {
    // Le piege : si les segments vides etaient ecrases, `/v1/items//sources` deviendrait
    // `/v1/items/sources` et matcherait `/v1/items/:id` avec `id = "sources"` - une URL
    // malformee partant en aval avec un identifiant invente.
    expect(matchRoute('GET', '/v1/items//sources')).toBeUndefined();
    expect(matchRoute('GET', '/v1//items/abc')).toBeUndefined();
  });

  it('tolere un slash final', () => {
    expect(matchRoute('GET', '/v1/collections/')?.rule.target.kind).toBe(
      'catalog:scatter',
    );
  });

  it('ne matche pas un chemin inconnu', () => {
    expect(matchRoute('GET', '/v1/unknown')).toBeUndefined();
    expect(matchRoute('GET', '/v1/collections/a/b/c')).toBeUndefined();
  });

  it('distingue verbe inconnu et chemin inconnu', () => {
    expect(matchRoute('PUT', '/v1/shares/abc')).toBeUndefined();
    expect(pathExists('/v1/shares/abc')).toBe(true);
    expect(allowedMethods('/v1/shares/abc').sort()).toEqual([
      'DELETE',
      'PATCH',
    ]);
    expect(pathExists('/v1/nowhere')).toBe(false);
  });
});

describe('ROUTE_TABLE', () => {
  it('n exige jamais le premium du proprietaire sans reference de collection', () => {
    // `premium: 'owner'` suppose une collection identifiable ; sans elle, il n'y a
    // personne dont verifier le statut et la regle serait inapplicable.
    for (const rule of ROUTE_TABLE) {
      if (rule.premium === 'owner') {
        expect(rule.target.kind).toBe('catalog:ref');
      }
    }
  });

  it('ne marque en ecriture que des routes a reference de collection', () => {
    // Le `403` reserve au membre n'a de sens que sur une collection donnee.
    for (const rule of ROUTE_TABLE) {
      if (rule.write) expect(rule.target.kind).toBe('catalog:ref');
    }
  });

  // `Authorization` porte le JWT de l'utilisateur : le retransmettre permettrait a un
  // service de le rejouer ailleurs. La seule route a le declarer est le webhook RTDN, dont
  // le jeton est signe par Google et que seul `billing` peut verifier.
  it('ne declare la retransmission d Authorization que pour le webhook RTDN', () => {
    const forwarding = ROUTE_TABLE.filter((r) => r.forwardAuthorization);
    expect(forwarding.map((r) => r.pattern)).toEqual([
      '/webhooks/google-play/rtdn',
    ]);
  });

  // Les routes admin portent `ADMIN_API_TOKEN`, pas un JWT : le service doit le recevoir
  // pour le reverifier, sinon il repond 401 a un appel que le gateway a deja accepte.
  it('retransmet Authorization pour toute route admin, jamais pour une route utilisateur', () => {
    const admin = ROUTE_TABLE.filter((r) => r.auth === 'admin');
    expect(admin.length).toBeGreaterThan(0);
    for (const rule of admin) expect(forwardsAuthorization(rule)).toBe(true);
    for (const rule of ROUTE_TABLE.filter((r) => r.auth === 'user')) {
      expect(forwardsAuthorization(rule)).toBe(false);
    }
    const publicForwarding = ROUTE_TABLE.filter(
      (r) => r.auth === 'public' && forwardsAuthorization(r),
    );
    expect(publicForwarding.map((r) => r.pattern)).toEqual([
      '/webhooks/google-play/rtdn',
    ]);
  });

  it('n expose aucune route /internal', () => {
    // Invariant du 6 : aucune route interne n'est joignable depuis l'exterieur.
    for (const rule of ROUTE_TABLE) {
      expect(rule.pattern.startsWith('/internal')).toBe(false);
    }
  });
});
