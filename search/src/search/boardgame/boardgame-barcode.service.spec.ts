import { BadRequestException, ConflictException } from '@nestjs/common';
import chooseFrom from '../../../test/fixtures/gameupc/lookup-choose-from.json';
import unknown from '../../../test/fixtures/gameupc/lookup-unknown.json';
import verified from '../../../test/fixtures/gameupc/lookup-verified.json';
import voteOk from '../../../test/fixtures/gameupc/vote-ok.json';
import {
  CachedGameUpcLookup,
  WireUpcInfoSchema,
  toUpcInfo,
} from '../../sources/gameupc/gameupc.types';
import { BoardGameBarcodeService } from './boardgame-barcode.service';
import { offeredCacheKey } from './boardgame-barcode.types';

const PEPPER = 'p'.repeat(32);

function entry(fixture: unknown): CachedGameUpcLookup {
  return {
    info: toUpcInfo(WireUpcInfoSchema.parse(fixture)),
    fetchedAt: '2026-11-04T07:35:56.000Z',
  };
}

const THING = { bggId: 148228, name: 'Splendor' };

function make(
  env: Record<string, string | undefined> = { GAMEUPC_VOTER_PEPPER: PEPPER },
) {
  const store = new Map<string, unknown>();
  const cache = {
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: unknown) => {
      store.set(k, v);
    }),
  };
  const gameUpc = {
    enabled: true,
    lookup: jest.fn().mockResolvedValue(null),
    cachedLookup: jest.fn().mockResolvedValue(null),
    lastKnown: jest.fn().mockResolvedValue(null),
    enqueueVote: jest.fn().mockResolvedValue(true),
  };
  const bgg = { thing: jest.fn().mockResolvedValue(null) };
  const config = { get: jest.fn((k: string) => env[k]) };
  const svc = new BoardGameBarcodeService(
    gameUpc as never,
    bgg as never,
    cache as never,
    config as never,
  );
  return { svc, gameUpc, bgg, cache, store };
}

describe('BoardGameBarcodeService.resolve — branches de statut', () => {
  it('verified : un seul candidat, fiche BGG demandée pour lui', async () => {
    const { svc, gameUpc, bgg } = make();
    gameUpc.lookup.mockResolvedValue(entry(verified));
    bgg.thing.mockResolvedValue(THING);

    const res = await svc.resolve('111111111117');

    expect(gameUpc.lookup).toHaveBeenCalledWith('111111111117', null);
    expect(res).toMatchObject({
      gtin: '0111111111117',
      upc: '111111111117',
      status: 'verified',
      searchedFor: 'splendor',
      details: THING,
      stale: false,
    });
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0]).toMatchObject({
      bggId: 148228,
      versionStatus: 'verified',
      pageUrl: 'https://boardgamegeek.com/boardgame/148228',
    });
    expect(bgg.thing).toHaveBeenCalledWith(148228);
  });

  it('choose_from_bgg_info_or_search : tous les candidats, versions à choisir, pas de fiche', async () => {
    const { svc, gameUpc, bgg } = make();
    gameUpc.lookup.mockResolvedValue(entry(chooseFrom));

    const res = await svc.resolve('3664824001215');

    expect(res.status).toBe('choose');
    expect(res.searchedFor).toBe('Kingdomino');
    expect(res.candidates.map((c) => c.bggId)).toEqual([
      204583, 281960, 240909,
    ]);
    expect(res.candidates[0].versionStatus).toBe('choose');
    expect(res.details).toBeNull();
    expect(bgg.thing).not.toHaveBeenCalled();
  });

  it('bgg_info vide : unknown, sans candidat', async () => {
    const { svc, gameUpc } = make();
    gameUpc.lookup.mockResolvedValue(entry(unknown));

    const res = await svc.resolve('333333333331');

    expect(res).toMatchObject({
      status: 'unknown',
      candidates: [],
      details: null,
    });
  });

  it('un statut GameUPC non documenté avec des jeux fait choisir au lieu de les perdre', async () => {
    const { svc, gameUpc } = make();
    const e = entry(chooseFrom);
    gameUpc.lookup.mockResolvedValue({
      ...e,
      info: { ...e.info, status: 'needs_review' },
    });

    expect((await svc.resolve('3664824001215')).status).toBe('choose');
  });

  it('transmet les termes saisis, normalisés', async () => {
    const { svc, gameUpc } = make();
    gameUpc.lookup.mockResolvedValue(entry(chooseFrom));

    await svc.resolve('3664824001215', { q: '  KingDomino   Duel ' });

    expect(gameUpc.lookup).toHaveBeenCalledWith(
      '3664824001215',
      'kingdomino duel',
    );
  });

  it('interroge GameUPC sous la forme UPC-A, quelle que soit la forme scannée', async () => {
    const { svc, gameUpc } = make();
    gameUpc.lookup.mockResolvedValue(entry(verified));

    await svc.resolve('0019962194719');
    await svc.resolve('19962194719');

    expect(gameUpc.lookup.mock.calls.map(([upc]) => upc)).toEqual([
      '019962194719',
      '019962194719',
    ]);
  });

  it('refuse un code invalide en 400, sans appeler GameUPC', async () => {
    const { svc, gameUpc } = make();

    await expect(svc.resolve('3664824001216')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.resolve('abc')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(gameUpc.lookup).not.toHaveBeenCalled();
  });
});

describe('BoardGameBarcodeService.resolve — repli', () => {
  it('GameUPC injoignable : sert la dernière réponse connue, marquée stale', async () => {
    const { svc, gameUpc, bgg } = make();
    gameUpc.lastKnown.mockResolvedValue(entry(verified));
    bgg.thing.mockResolvedValue(THING);

    const res = await svc.resolve('111111111117');

    expect(res).toMatchObject({
      status: 'verified',
      stale: true,
      details: THING,
    });
  });

  it('GameUPC injoignable et rien de connu : unavailable, distinct d’un code inconnu', async () => {
    const { svc } = make();

    const res = await svc.resolve('111111111117');

    expect(res).toMatchObject({
      status: 'unavailable',
      candidates: [],
      details: null,
      stale: false,
    });
  });

  it('ne sert pas la dernière réponse connue à une recherche saisie', async () => {
    const { svc, gameUpc } = make();
    gameUpc.lastKnown.mockResolvedValue(entry(verified));

    const res = await svc.resolve('111111111117', { q: 'splendor duel' });

    expect(res.status).toBe('unavailable');
    expect(gameUpc.lastKnown).not.toHaveBeenCalled();
  });

  it('sans licence BGG (fiche absente), le jeu vérifié reste servi avec les données GameUPC', async () => {
    const { svc, gameUpc, bgg } = make();
    gameUpc.lookup.mockResolvedValue(entry(verified));
    bgg.thing.mockResolvedValue(null);

    const res = await svc.resolve('111111111117');

    expect(res.status).toBe('verified');
    expect(res.details).toBeNull();
    expect(res.candidates[0]).toMatchObject({
      name: 'Splendor',
      imageUrl: expect.any(String),
    });
  });
});

describe('BoardGameBarcodeService.choose', () => {
  async function offered(
    svc: BoardGameBarcodeService,
    gameUpc: { lookup: jest.Mock },
  ) {
    gameUpc.lookup.mockResolvedValue(entry(chooseFrom));
    await svc.resolve('3664824001215');
  }

  it('enfile le vote sous pseudonyme, jamais sous l’identifiant Acervatim', async () => {
    const { svc, gameUpc, bgg } = make();
    await offered(svc, gameUpc);
    bgg.thing.mockResolvedValue({ bggId: 204583, name: 'Kingdomino' });

    const res = await svc.choose('user-123', '3664824001215', {
      bggId: 204583,
      versionId: 646653,
    });

    expect(res).toEqual({
      feedback: 'queued',
      reason: null,
      details: { bggId: 204583, name: 'Kingdomino' },
    });
    const [vote] = gameUpc.enqueueVote.mock.calls[0];
    expect(vote).toMatchObject({
      upc: '3664824001215',
      bggId: 204583,
      versionId: 646653,
    });
    expect(vote.voterId).toMatch(/^acv-[A-Za-z0-9_-]{22}$/);
    expect(vote.voterId).not.toContain('user-123');
  });

  it('donne à un utilisateur le même pseudonyme à chaque vote, un autre à chacun', () => {
    const { svc } = make();

    expect(svc.voterId('user-123')).toBe(svc.voterId('user-123'));
    expect(svc.voterId('user-123')).not.toBe(svc.voterId('user-456'));
    // GameUPC refuse un user_id de moins de 8 caractères.
    expect(svc.voterId('u')!.length).toBeGreaterThanOrEqual(8);
  });

  it('refuse en 409 un jeu ou une version qui n’a pas été proposé pour ce code', async () => {
    const { svc, gameUpc } = make();

    await expect(
      svc.choose('user-123', '3664824001215', { bggId: 204583 }),
    ).rejects.toBeInstanceOf(ConflictException);

    await offered(svc, gameUpc);
    await expect(
      svc.choose('user-123', '3664824001215', { bggId: 174430 }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      svc.choose('user-123', '3664824001215', { bggId: 204583, versionId: 1 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(gameUpc.enqueueVote).not.toHaveBeenCalled();
  });

  it('accepte un jeu proposé par une recherche antérieure, pas seulement par la dernière', async () => {
    const { svc, gameUpc, store } = make();
    await offered(svc, gameUpc);
    const e = entry(chooseFrom);
    gameUpc.lookup.mockResolvedValue({
      ...e,
      info: { ...e.info, games: [e.info.games[2]] },
    });
    await svc.resolve('3664824001215', { q: 'age of giants' });

    const remembered = store.get(offeredCacheKey('3664824001215')) as {
      games: Record<string, number[]>;
    };
    expect(Object.keys(remembered.games).sort()).toEqual([
      '204583',
      '240909',
      '281960',
    ]);
    await expect(
      svc.choose('user-123', '3664824001215', { bggId: 281960 }),
    ).resolves.toMatchObject({ feedback: 'queued' });
  });

  it('ne vote pas pour confirmer un code déjà vérifié', async () => {
    const { svc, gameUpc } = make();
    gameUpc.lookup.mockResolvedValue(entry(verified));
    await svc.resolve('111111111117');
    gameUpc.cachedLookup.mockResolvedValue(entry(verified));

    const res = await svc.choose('user-123', '111111111117', { bggId: 148228 });

    expect(res).toMatchObject({
      feedback: 'skipped',
      reason: 'already-verified',
    });
    expect(gameUpc.enqueueVote).not.toHaveBeenCalled();
  });

  it('vote pour préciser la version d’un jeu vérifié dont l’édition reste à choisir', async () => {
    // État réel de Kingdomino FR après un vote : jeu vérifié, `choose_from_versions`.
    const { svc, gameUpc } = make();
    gameUpc.lookup.mockResolvedValue(entry(voteOk));
    await svc.resolve('3664824001215');
    gameUpc.cachedLookup.mockResolvedValue(entry(voteOk));

    const res = await svc.choose('user-123', '3664824001215', {
      bggId: 204583,
      versionId: 413317,
    });

    expect(res.feedback).toBe('queued');
  });

  it('sans pepper, garde le choix mais n’envoie rien', async () => {
    const { svc, gameUpc } = make({});
    await offered(svc, gameUpc);

    const res = await svc.choose('user-123', '3664824001215', {
      bggId: 204583,
    });

    expect(res).toMatchObject({
      feedback: 'skipped',
      reason: 'feedback-disabled',
    });
    expect(gameUpc.enqueueVote).not.toHaveBeenCalled();
  });

  it('file injoignable : le choix est accepté, le partage signalé perdu', async () => {
    const { svc, gameUpc } = make();
    await offered(svc, gameUpc);
    gameUpc.enqueueVote.mockResolvedValue(false);

    const res = await svc.choose('user-123', '3664824001215', {
      bggId: 204583,
    });

    expect(res).toMatchObject({
      feedback: 'skipped',
      reason: 'queue-unavailable',
    });
  });
});
