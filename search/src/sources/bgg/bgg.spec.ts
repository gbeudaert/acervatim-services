import { BadGatewayException } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  HttpClientError,
  HttpRetryableError,
} from '../../common/http/http-client.service';
import { parseThing } from './bgg-thing.parser';
import { BggError, BggHttpClient } from './bgg.client';
import { BggProcessor } from './bgg.processor';
import {
  BGG_RATE_LIMIT_PAUSE_MS,
  THING_MISS_TTL_SECONDS,
  THING_TTL_SECONDS,
  thingCacheKey,
} from './bgg.types';

const XML = readFileSync(
  join(__dirname, '../../../test/fixtures/bgg/thing-kingdomino.xml'),
  'utf-8',
);

describe('parseThing', () => {
  it('lit la fiche sans réécrire les données BGG', () => {
    const thing = parseThing(XML, 204583);

    expect(thing).toMatchObject({
      bggId: 204583,
      type: 'boardgame',
      name: 'Kingdomino',
      yearPublished: 2016,
      minPlayers: 2,
      maxPlayers: 4,
      playingTime: 15,
      minAge: 8,
      designers: ['Bruno Cathala'],
      mechanics: ['Tile Placement'],
      categories: ['City Building', 'Territory Building'],
      expands: [],
      rating: {
        average: 7.37,
        bayesAverage: 7.24,
        usersRated: 48000,
        rank: 218,
      },
    });
    expect(thing?.imageUrl).toMatch(/^https:\/\/cf\.geekdo-images\.com\//);
  });

  it('décode les entités, y compris celles que BGG double-échappe', () => {
    const thing = parseThing(XML, 204583)!;

    expect(thing.alternateNames).toEqual([
      "Kingdomino: L'édition française",
      '王国骨牌',
    ]);
    expect(thing.publishers).toEqual(['Blue Orange (EU)', 'Pegasus Spiele']);
    expect(thing.description).toBe(
      'In Kingdomino, you are a Lord seeking new lands in which to expand your kingdom.\n\n' +
        'You must explore all the lands — wheat fields, lakes, and mountains — in order to spot the best plots.',
    );
  });

  it('admet un > littéral dans une valeur d’attribut', () => {
    const xml =
      '<items><item type="boardgame" id="7"><name type="primary" value="A > B" /></item></items>';

    expect(parseThing(xml, 7)?.name).toBe('A > B');
  });

  it('lit le jeu de base d’une extension, et « Not Ranked » comme absence de rang', () => {
    const xml = `<items><item type="boardgameexpansion" id="240909">
      <name type="primary" value="Kingdomino: Age of Giants" />
      <link type="boardgameexpansion" id="204583" value="Kingdomino" inbound="true" />
      <rank type="subtype" id="1" name="boardgame" value="Not Ranked" />
    </item></items>`;

    expect(parseThing(xml, 240909)).toMatchObject({
      type: 'boardgameexpansion',
      expands: [204583],
      rating: { rank: null },
    });
  });

  it('rend null pour un id inconnu ou une fiche d’un autre jeu', () => {
    expect(
      parseThing(
        '<items termsofuse="https://boardgamegeek.com/xmlapi/termsofuse"></items>',
        1,
      ),
    ).toBeNull();
    expect(parseThing(XML, 1)).toBeNull();
  });
});

describe('BggHttpClient', () => {
  function make(opts: { token?: string } = { token: 'tok' }) {
    const values: Record<string, string | undefined> = {
      BGG_API_TOKEN: opts.token,
      BGG_BASE_URL: 'https://boardgamegeek.com/xmlapi2',
    };
    const config = { get: jest.fn((k: string) => values[k]) };
    const http = { request: jest.fn() };
    return { client: new BggHttpClient(config as never, http as never), http };
  }

  it('appelle boardgamegeek.com sans www, jeton en Bearer, une seule tentative', async () => {
    const { client, http } = make();
    http.request.mockResolvedValue({ status: 200, headers: {}, data: XML });

    expect((await client.thing(204583))?.name).toBe('Kingdomino');

    const [url, opts] = http.request.mock.calls[0];
    expect(new URL(url).hostname).toBe('boardgamegeek.com');
    expect(url).toBe(
      'https://boardgamegeek.com/xmlapi2/thing?id=204583&stats=1',
    );
    expect(opts.headers.Authorization).toBe('Bearer tok');
    expect(opts.maxAttempts).toBe(1);
  });

  it('ne part pas sans jeton (licence non accordée)', async () => {
    const { client, http } = make({});

    expect(client.enabled).toBe(false);
    await expect(client.thing(204583)).rejects.toMatchObject({
      kind: 'disabled',
    });
    expect(http.request).not.toHaveBeenCalled();
  });

  it.each([429, 503])('traduit un %s en débit dépassé', async (status) => {
    const { client, http } = make();
    http.request.mockRejectedValue(
      new BadGatewayException('upstream unavailable', {
        cause: new HttpRetryableError(`${status}`, status, 20_000),
      }),
    );

    await expect(client.thing(204583)).rejects.toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 20_000,
    });
  });

  it('traduit un 401 en jeton refusé et un 202 en réponse différée', async () => {
    const { client, http } = make();
    http.request.mockRejectedValueOnce(new HttpClientError('401', 401, ''));
    await expect(client.thing(204583)).rejects.toMatchObject({
      kind: 'unauthorized',
    });

    http.request.mockResolvedValueOnce({ status: 202, headers: {}, data: '' });
    await expect(client.thing(204583)).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });
});

describe('BggProcessor', () => {
  function make() {
    const client = { enabled: true, thing: jest.fn() };
    const cache = { set: jest.fn() };
    const proc = new BggProcessor(client as never, cache as never);
    const worker = { rateLimit: jest.fn().mockResolvedValue(undefined) };
    (proc as unknown as { _worker: unknown })._worker = worker;
    const job = { data: { bggId: 204583 } } as Job;
    return { proc, client, cache, worker, job };
  }

  it('cache une fiche 30 jours, une absence 7 jours', async () => {
    const { proc, client, cache, job } = make();
    client.thing.mockResolvedValueOnce({ bggId: 204583 });
    await proc.process(job);
    expect(cache.set).toHaveBeenCalledWith(
      thingCacheKey(204583),
      { thing: { bggId: 204583 } },
      THING_TTL_SECONDS,
    );

    client.thing.mockResolvedValueOnce(null);
    await proc.process(job);
    expect(cache.set).toHaveBeenLastCalledWith(
      thingCacheKey(204583),
      { thing: null },
      THING_MISS_TTL_SECONDS,
    );
  });

  it('met la file en pause sur 429/503 et laisse retenter', async () => {
    const { proc, client, worker, job } = make();
    client.thing.mockRejectedValue(new BggError('rate_limited', '429'));

    const err = await proc.process(job).catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(worker.rateLimit).toHaveBeenCalledWith(BGG_RATE_LIMIT_PAUSE_MS);
  });

  it('ne retente pas un jeton refusé', async () => {
    const { proc, client, job } = make();
    client.thing.mockRejectedValue(new BggError('unauthorized', '401'));

    await expect(proc.process(job)).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
