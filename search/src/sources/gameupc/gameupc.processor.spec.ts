import { Job, UnrecoverableError } from 'bullmq';
import chooseFrom from '../../../test/fixtures/gameupc/lookup-choose-from.json';
import verified from '../../../test/fixtures/gameupc/lookup-verified.json';
import voteOk from '../../../test/fixtures/gameupc/vote-ok.json';
import { GameUpcError } from './gameupc.client';
import { GameUpcFeedbackProcessor } from './gameupc-feedback.processor';
import { GameUpcLookupProcessor } from './gameupc.processor';
import {
  GAMEUPC_RATE_LIMIT_PAUSE_MS,
  GameUpcVoteJobData,
  LAST_KNOWN_TTL_SECONDS,
  UNVERIFIED_TTL_SECONDS,
  VERIFIED_TTL_SECONDS,
  WireUpcInfoSchema,
  lastKnownCacheKey,
  lookupCacheKey,
  toUpcInfo,
} from './gameupc.types';

const VERIFIED = toUpcInfo(WireUpcInfoSchema.parse(verified));
const CHOOSE = toUpcInfo(WireUpcInfoSchema.parse(chooseFrom));
const AFTER_VOTE = toUpcInfo(WireUpcInfoSchema.parse(voteOk));

function client() {
  return {
    enabled: true,
    lookup: jest.fn(),
    vote: jest.fn(),
    recordedVote: jest.fn(),
  };
}

/** Le getter `worker` de `WorkerHost` lit `_worker`, posé par Nest au démarrage. */
function withWorker<T extends object>(proc: T) {
  const worker = { rateLimit: jest.fn().mockResolvedValue(undefined) };
  (proc as unknown as { _worker: unknown })._worker = worker;
  return worker;
}

describe('GameUpcLookupProcessor', () => {
  function make() {
    const gameUpc = client();
    const cache = { set: jest.fn() };
    const proc = new GameUpcLookupProcessor(gameUpc as never, cache as never);
    const worker = withWorker(proc);
    return { proc, gameUpc, cache, worker };
  }

  function job(upc: string, search: string | null) {
    return { data: { upc, search }, attemptsMade: 0 } as Job;
  }

  it('met un code vérifié en cache long, et en dernière réponse connue', async () => {
    const { proc, gameUpc, cache } = make();
    gameUpc.lookup.mockResolvedValue(VERIFIED);

    const res = await proc.process(job('111111111117', null));

    expect(res.info).toEqual(VERIFIED);
    expect(gameUpc.lookup).toHaveBeenCalledWith('111111111117', {
      search: null,
      mode: 'quality',
    });
    expect(cache.set).toHaveBeenCalledWith(
      lookupCacheKey('111111111117', null),
      res,
      VERIFIED_TTL_SECONDS,
    );
    expect(cache.set).toHaveBeenCalledWith(
      lastKnownCacheKey('111111111117'),
      res,
      LAST_KNOWN_TTL_SECONDS,
    );
  });

  it('garde une suggestion non vérifiée un jour seulement : d’autres votes peuvent la vérifier', async () => {
    const { proc, gameUpc, cache } = make();
    gameUpc.lookup.mockResolvedValue(CHOOSE);

    await proc.process(job('3664824001215', null));

    expect(cache.set).toHaveBeenCalledWith(
      lookupCacheKey('3664824001215', null),
      expect.anything(),
      UNVERIFIED_TTL_SECONDS,
    );
  });

  it('n’écrit pas la dernière réponse connue pour une recherche saisie', async () => {
    const { proc, gameUpc, cache } = make();
    gameUpc.lookup.mockResolvedValue(CHOOSE);

    await proc.process(job('3664824001215', 'kingdomino'));

    expect(cache.set).toHaveBeenCalledTimes(1);
    expect(cache.set.mock.calls[0][0]).toBe(
      lookupCacheKey('3664824001215', 'kingdomino'),
    );
  });

  it('met toute la file en pause sur 429, puis échoue sans rien cacher', async () => {
    const { proc, gameUpc, cache, worker } = make();
    gameUpc.lookup.mockRejectedValue(
      new GameUpcError('rate_limited', '429', 5_000),
    );

    await expect(proc.process(job('111111111117', null))).rejects.toMatchObject(
      {
        kind: 'rate_limited',
      },
    );
    expect(worker.rateLimit).toHaveBeenCalledWith(5_000);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('pause par défaut sans Retry-After, aucune pause sur une simple panne', async () => {
    const { proc, gameUpc, worker } = make();
    gameUpc.lookup.mockRejectedValueOnce(
      new GameUpcError('rate_limited', '429'),
    );
    await expect(proc.process(job('111111111117', null))).rejects.toThrow();
    expect(worker.rateLimit).toHaveBeenCalledWith(GAMEUPC_RATE_LIMIT_PAUSE_MS);

    worker.rateLimit.mockClear();
    gameUpc.lookup.mockRejectedValueOnce(
      new GameUpcError('unavailable', '503'),
    );
    await expect(proc.process(job('111111111117', null))).rejects.toThrow();
    expect(worker.rateLimit).not.toHaveBeenCalled();
  });
});

describe('GameUpcFeedbackProcessor', () => {
  const VOTE: GameUpcVoteJobData = {
    upc: '3664824001215',
    bggId: 204583,
    versionId: null,
    voterId: 'acv-aaaaaaaaaaaaaaaaaaaaaa',
    chosenAt: '2026-11-04T08:00:00.000Z',
  };

  function make() {
    const gameUpc = client();
    const cache = { set: jest.fn() };
    const proc = new GameUpcFeedbackProcessor(gameUpc as never, cache as never);
    const worker = withWorker(proc);
    return { proc, gameUpc, cache, worker };
  }

  function job(data: GameUpcVoteJobData, attemptsMade = 0) {
    return { data, attemptsMade } as Job<GameUpcVoteJobData>;
  }

  it('envoie le vote et remplace la consultation cachée par l’état renvoyé', async () => {
    const { proc, gameUpc, cache } = make();
    gameUpc.vote.mockResolvedValue(AFTER_VOTE);

    expect(await proc.process(job(VOTE))).toBe('sent');

    expect(gameUpc.vote).toHaveBeenCalledWith(VOTE);
    expect(gameUpc.recordedVote).not.toHaveBeenCalled();
    expect(cache.set).toHaveBeenCalledWith(
      lookupCacheKey(VOTE.upc, null),
      expect.objectContaining({ info: AFTER_VOTE }),
      VERIFIED_TTL_SECONDS,
    );
  });

  it('est rejouable : deux exécutions du même job envoient le même vote, au même état', async () => {
    // Worker tué après l'appel, avant l'acquittement : BullMQ rejoue. GameUPC garde un vote par
    // (code, votant) — mesuré sur le serveur de test : deux POST identiques, même réponse.
    const { proc, gameUpc, cache } = make();
    gameUpc.vote.mockResolvedValue(AFTER_VOTE);

    await proc.process(job(VOTE));
    await proc.process(job(VOTE));

    expect(gameUpc.vote).toHaveBeenCalledTimes(2);
    expect(gameUpc.vote.mock.calls[0]).toEqual(gameUpc.vote.mock.calls[1]);
    const written = cache.set.mock.calls.filter(
      ([key]) => key === lookupCacheKey(VOTE.upc, null),
    );
    expect(written[0][1].info).toEqual(written[1][1].info);
  });

  it('laisse BullMQ retenter une panne, sans pause de file', async () => {
    const { proc, gameUpc, worker } = make();
    gameUpc.vote.mockRejectedValue(new GameUpcError('unavailable', '503'));

    const err = await proc.process(job(VOTE)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GameUpcError);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(worker.rateLimit).not.toHaveBeenCalled();
  });

  it('met la file en pause sur 429 et laisse retenter', async () => {
    const { proc, gameUpc, worker } = make();
    gameUpc.vote.mockRejectedValue(new GameUpcError('rate_limited', '429'));

    const err = await proc.process(job(VOTE)).catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(worker.rateLimit).toHaveBeenCalledWith(GAMEUPC_RATE_LIMIT_PAUSE_MS);
  });

  it.each([
    'rejected',
    'unauthorized',
    'invalid_response',
    'disabled',
  ] as const)('ne retente pas un refus (%s)', async (kind) => {
    const { proc, gameUpc } = make();
    gameUpc.vote.mockRejectedValue(new GameUpcError(kind, 'nope'));

    await expect(proc.process(job(VOTE))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  describe('sur une nouvelle tentative', () => {
    it('s’abstient si le votant a fait depuis un autre choix, déjà enregistré', async () => {
      const { proc, gameUpc, cache } = make();
      gameUpc.recordedVote.mockResolvedValue({
        upc: VOTE.upc,
        bggId: 281960,
        versionId: null,
        recordedAt: '2026-11-04T08:05:00.000Z',
      });

      expect(await proc.process(job(VOTE, 1))).toBe('superseded');
      expect(gameUpc.vote).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalled();
    });

    it('ne renvoie pas un vote que la tentative précédente a déjà fait enregistrer', async () => {
      const { proc, gameUpc } = make();
      gameUpc.recordedVote.mockResolvedValue({
        upc: VOTE.upc,
        bggId: VOTE.bggId,
        versionId: null,
        recordedAt: '2026-11-04T08:00:01.000Z',
      });

      expect(await proc.process(job(VOTE, 2))).toBe('sent');
      expect(gameUpc.vote).not.toHaveBeenCalled();
    });

    it('renvoie le vote si l’enregistré est plus ancien, ou absent', async () => {
      const { proc, gameUpc } = make();
      gameUpc.vote.mockResolvedValue(AFTER_VOTE);
      gameUpc.recordedVote.mockResolvedValueOnce({
        upc: VOTE.upc,
        bggId: 281960,
        versionId: null,
        recordedAt: '2026-11-03T20:00:00.000Z',
      });
      gameUpc.recordedVote.mockResolvedValueOnce(null);

      expect(await proc.process(job(VOTE, 1))).toBe('sent');
      expect(await proc.process(job(VOTE, 1))).toBe('sent');
      expect(gameUpc.vote).toHaveBeenCalledTimes(2);
    });
  });
});
