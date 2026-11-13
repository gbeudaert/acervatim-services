import { BadGatewayException } from '@nestjs/common';
import {
  HttpClientError,
  HttpRetryableError,
} from '../../common/http/http-client.service';
import chooseFrom from '../../../test/fixtures/gameupc/lookup-choose-from.json';
import unknown from '../../../test/fixtures/gameupc/lookup-unknown.json';
import verified from '../../../test/fixtures/gameupc/lookup-verified.json';
import badRequest from '../../../test/fixtures/gameupc/error-bad-request.json';
import forbidden from '../../../test/fixtures/gameupc/error-forbidden.json';
import userVote from '../../../test/fixtures/gameupc/user-vote.json';
import userVoteNotFound from '../../../test/fixtures/gameupc/user-vote-not-found.json';
import voteOk from '../../../test/fixtures/gameupc/vote-ok.json';
import { GameUpcError, GameUpcHttpClient } from './gameupc.client';

function make(env: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    GAMEUPC_BASE_URL: 'https://api.gameupc.com/test',
    GAMEUPC_API_KEY: 'test_test_test_test_test',
    ...env,
  };
  const config = { get: jest.fn((k: string) => values[k]) };
  const http = { request: jest.fn() };
  const client = new GameUpcHttpClient(config as never, http as never);
  return { client, http };
}

function ok(data: unknown) {
  return { status: 200, headers: {}, data };
}

/** Échec retentable épuisé, tel que `HttpClientService` le jette (statut gardé en `cause`). */
function exhausted(status: number, retryAfterMs?: number) {
  return new BadGatewayException('upstream unavailable', {
    cause: new HttpRetryableError(`${status}`, status, retryAfterMs),
  });
}

describe('GameUpcHttpClient.lookup', () => {
  it('lit un code vérifié et retire les URLs GameUPC du modèle', async () => {
    const { client, http } = make();
    http.request.mockResolvedValue(ok(verified));

    const info = await client.lookup('111111111117');

    expect(info).toMatchObject({
      upc: '111111111117',
      name: 'Splendor',
      searchedFor: 'splendor',
      status: 'verified',
      isNew: false,
    });
    expect(info.games).toHaveLength(1);
    expect(info.games[0]).toMatchObject({
      bggId: 148228,
      name: 'Splendor',
      published: 2014,
      pageUrl: 'https://boardgamegeek.com/boardgame/148228',
      confidence: 96,
      versionStatus: 'verified',
    });
    expect(info.games[0].versions[0]).toMatchObject({
      versionId: 393050,
      language: 'English',
      published: 2013,
    });
    // `update_url` (environnement GameUPC) et `data_url` (api.geekdo.com, jeton ignoré) ne sortent pas.
    expect(JSON.stringify(info)).not.toContain('update_url');
    expect(JSON.stringify(info)).not.toContain('api.geekdo.com');
  });

  it('lit des suggestions à choisir (EAN Blue Orange réel, versions françaises)', async () => {
    const { client, http } = make();
    http.request.mockResolvedValue(ok(chooseFrom));

    const info = await client.lookup('3664824001215');

    expect(info.status).toBe('choose_from_bgg_info_or_search');
    expect(info.games.map((g) => g.bggId)).toEqual([204583, 281960, 240909]);
    expect(info.games[0].versionStatus).toBe('choose_from_versions');
    expect(info.games[0].versions.map((v) => v.language)).toContain('French');
  });

  it('lit un code inconnu : aucune suggestion, enregistrement créé chez GameUPC', async () => {
    const { client, http } = make();
    http.request.mockResolvedValue(ok(unknown));

    const info = await client.lookup('333333333331');

    expect(info).toEqual({
      upc: '333333333331',
      name: null,
      searchedFor: null,
      status: 'choose_from_bgg_info_or_search',
      games: [],
      isNew: true,
    });
  });

  it('envoie la clé, les termes de recherche et le mode', async () => {
    const { client, http } = make();
    http.request.mockResolvedValue(ok(unknown));

    await client.lookup('333333333331', {
      search: 'tsuro of the seas',
      mode: 'quality',
    });

    const [url, opts] = http.request.mock.calls[0];
    expect(url).toBe(
      'https://api.gameupc.com/test/upc/333333333331?search=tsuro+of+the+seas&search_mode=quality',
    );
    expect(opts.method).toBe('GET');
    expect(opts.headers['x-api-key']).toBe('test_test_test_test_test');
  });

  it('lit le nom du statut documenté par le Swagger en repli', async () => {
    const { client, http } = make();
    const swaggerShaped: Record<string, unknown> = {
      ...verified,
      bgg_status: 'verified',
    };
    delete swaggerShaped.bgg_info_status;
    http.request.mockResolvedValue(ok(swaggerShaped));

    expect((await client.lookup('111111111117')).status).toBe('verified');
  });

  it('refuse un corps illisible plutôt que de rendre un résultat vide', async () => {
    const { client, http } = make();
    http.request.mockResolvedValue(ok('<html>maintenance</html>'));

    await expect(client.lookup('111111111117')).rejects.toMatchObject({
      kind: 'invalid_response',
      retryable: false,
    });
  });

  it('ne part pas sans clé', async () => {
    const { client, http } = make({ GAMEUPC_API_KEY: undefined });

    expect(client.enabled).toBe(false);
    await expect(client.lookup('111111111117')).rejects.toMatchObject({
      kind: 'disabled',
    });
    expect(http.request).not.toHaveBeenCalled();
  });
});

describe('GameUpcHttpClient — traduction des erreurs', () => {
  it.each([
    [
      'un 400 en refus définitif, avec le message GameUPC',
      new HttpClientError('400 client error', 400, badRequest),
      { kind: 'rejected', retryable: false, message: badRequest.message },
    ],
    [
      'le 403 de la passerelle (clé absente ou fausse) en clé refusée',
      new HttpClientError('403 client error', 403, forbidden),
      { kind: 'unauthorized', retryable: false, message: 'Forbidden' },
    ],
    [
      'un 429 épuisé en débit dépassé, Retry-After compris',
      exhausted(429, 12_000),
      { kind: 'rate_limited', retryable: true, retryAfterMs: 12_000 },
    ],
    [
      'un 503 épuisé en indisponibilité',
      exhausted(503),
      { kind: 'unavailable', retryable: true },
    ],
    [
      'une erreur réseau en indisponibilité',
      new Error('fetch failed'),
      { kind: 'unavailable', retryable: true },
    ],
  ])('traduit %s', async (_label, thrown, expected) => {
    const { client, http } = make();
    http.request.mockRejectedValue(thrown);

    const err = await client.lookup('111111111117').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GameUpcError);
    expect(err).toMatchObject(expected);
  });
});

describe('GameUpcHttpClient.vote', () => {
  it('poste le pseudonyme sur le chemin reconstruit, sans version', async () => {
    const { client, http } = make();
    http.request.mockResolvedValue(ok(voteOk));

    const info = await client.vote({
      upc: '3664824001215',
      bggId: 204583,
      versionId: null,
      voterId: 'acv-xxxxxxxxxxxxxxxxxxxxxx',
    });

    const [url, opts] = http.request.mock.calls[0];
    expect(url).toBe(
      'https://api.gameupc.com/test/upc/3664824001215/bgg_id/204583',
    );
    expect(opts).toMatchObject({ method: 'POST', maxAttempts: 1 });
    expect(JSON.parse(opts.body)).toEqual({
      user_id: 'acv-xxxxxxxxxxxxxxxxxxxxxx',
    });
    expect(info.status).toBe('verified');
    expect(info.games[0].bggId).toBe(204583);
  });

  it('vise le chemin de version quand une édition est choisie', async () => {
    const { client, http } = make({
      GAMEUPC_BASE_URL: 'https://api.gameupc.com/v1/',
    });
    http.request.mockResolvedValue(ok(voteOk));

    await client.vote({
      upc: '3664824001215',
      bggId: 204583,
      versionId: 646653,
      voterId: 'acv-xxxxxxxxxxxxxxxxxxxxxx',
    });

    expect(http.request.mock.calls[0][0]).toBe(
      'https://api.gameupc.com/v1/upc/3664824001215/bgg_id/204583/version/646653',
    );
  });

  it('retire les apostrophes échappées des noms de version renvoyés après un vote', async () => {
    const { client, http } = make();
    http.request.mockResolvedValue(ok(voteOk));

    const info = await client.vote({
      upc: '3664824001215',
      bggId: 204583,
      versionId: null,
      voterId: 'acv-xxxxxxxxxxxxxxxxxxxxxx',
    });

    expect(info.games[0].versions[0].name).toBe("Kingdomino (K-Domino'Z)");
  });
});

describe('GameUpcHttpClient.recordedVote', () => {
  it('lit le vote enregistré, date ramenée en UTC explicite, version 0 = aucune', async () => {
    const { client, http } = make();
    http.request.mockResolvedValue(ok(userVote));

    expect(
      await client.recordedVote('3664824001215', 'acervatim-probe-0001'),
    ).toEqual({
      upc: '3664824001215',
      bggId: 204583,
      versionId: null,
      recordedAt: '2026-11-04T07:37:48.565376Z',
    });
  });

  it('rend null quand le votant n’a pas voté (404)', async () => {
    const { client, http } = make();
    http.request.mockRejectedValue(
      new HttpClientError('404 client error', 404, userVoteNotFound),
    );

    expect(
      await client.recordedVote('3664824001215', 'acervatim-probe-0001'),
    ).toBeNull();
  });
});
