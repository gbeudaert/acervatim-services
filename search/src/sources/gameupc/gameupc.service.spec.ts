import { GameUpcService } from './gameupc.service';
import {
  GAMEUPC_LOOKUP_JOB,
  GAMEUPC_VOTE_JOB,
  lookupCacheKey,
  voteJobId,
} from './gameupc.types';

function make(opts: { enabled?: boolean; redis?: boolean } = {}) {
  const lookupQueue = {
    add: jest.fn().mockResolvedValue({
      waitUntilFinished: jest.fn().mockResolvedValue({ info: 'fresh' }),
    }),
  };
  const feedbackQueue = { add: jest.fn().mockResolvedValue({}) };
  const client = { enabled: opts.enabled ?? true };
  const cache = { get: jest.fn().mockResolvedValue(null) };
  const redisHealth = {
    isAvailable: jest.fn().mockReturnValue(opts.redis ?? true),
  };
  const svc = new GameUpcService(
    lookupQueue as never,
    feedbackQueue as never,
    client as never,
    { get: jest.fn() } as never,
    cache as never,
    redisHealth as never,
  );
  // Court-circuite onModuleInit (connexion Redis réelle) : waitUntilFinished est mocké sur le job.
  (svc as unknown as { queueEvents: unknown }).queueEvents = {};
  return { svc, lookupQueue, feedbackQueue, cache };
}

const VOTE = {
  upc: '3664824001215',
  bggId: 204583,
  versionId: null,
  voterId: 'acv-aaaaaaaaaaaaaaaaaaaaaa',
};

describe('GameUpcService.lookup', () => {
  it('sert le cache sans enfiler', async () => {
    const { svc, lookupQueue, cache } = make();
    cache.get.mockResolvedValue({ info: 'cached' });

    expect(await svc.lookup('3664824001215', null)).toEqual({ info: 'cached' });
    expect(lookupQueue.add).not.toHaveBeenCalled();
  });

  it('enfile une consultation single-flight sur la clé de cache, sans retry différé', async () => {
    const { svc, lookupQueue } = make();

    expect(await svc.lookup('3664824001215', 'kingdomino')).toEqual({
      info: 'fresh',
    });
    const [name, data, options] = lookupQueue.add.mock.calls[0];
    expect(name).toBe(GAMEUPC_LOOKUP_JOB);
    expect(data).toEqual({ upc: '3664824001215', search: 'kingdomino' });
    expect(options).toMatchObject({
      jobId: lookupCacheKey('3664824001215', 'kingdomino'),
      attempts: 1,
    });
  });

  it('rend null sans clé, Redis en panne, ou délai dépassé — jamais d’exception', async () => {
    expect(
      await make({ enabled: false }).svc.lookup('3664824001215', null),
    ).toBeNull();
    expect(
      await make({ redis: false }).svc.lookup('3664824001215', null),
    ).toBeNull();

    const { svc, lookupQueue } = make();
    lookupQueue.add.mockResolvedValue({
      waitUntilFinished: jest.fn().mockRejectedValue(new Error('timeout')),
    });
    expect(await svc.lookup('3664824001215', null)).toBeNull();
  });
});

describe('GameUpcService.enqueueVote', () => {
  it('enfile le vote avec un retry long et un jobId déterministe', async () => {
    const { svc, feedbackQueue } = make();
    const chosenAt = new Date('2026-11-04T08:00:00.000Z');

    expect(await svc.enqueueVote(VOTE, chosenAt)).toBe(true);

    const [name, data, options] = feedbackQueue.add.mock.calls[0];
    expect(name).toBe(GAMEUPC_VOTE_JOB);
    expect(data).toEqual({ ...VOTE, chosenAt: '2026-11-04T08:00:00.000Z' });
    expect(options).toMatchObject({
      jobId: voteJobId(VOTE),
      attempts: 6,
      backoff: { type: 'exponential', delay: 30_000 },
      // Ne déduplique que les envois en cours : A, puis B, puis A doit finir sur A.
      removeOnComplete: true,
    });
  });

  it('donne le même jobId à un double envoi du même choix, un autre à tout autre choix', async () => {
    const { svc, feedbackQueue } = make();

    await svc.enqueueVote(VOTE);
    await svc.enqueueVote(VOTE);
    await svc.enqueueVote({ ...VOTE, versionId: 646653 });
    await svc.enqueueVote({ ...VOTE, bggId: 281960 });
    await svc.enqueueVote({ ...VOTE, voterId: 'acv-bbbbbbbbbbbbbbbbbbbbbb' });

    const ids = feedbackQueue.add.mock.calls.map(([, , o]) => o.jobId);
    expect(ids[0]).toBe(ids[1]);
    expect(new Set(ids).size).toBe(4);
    // Le jobId ne porte ni le code ni le pseudonyme en clair.
    expect(ids[0]).not.toContain(VOTE.voterId);
    expect(ids[0]).not.toContain(VOTE.upc);
  });

  it('rend false au lieu de jeter quand la file est injoignable', async () => {
    expect(await make({ redis: false }).svc.enqueueVote(VOTE)).toBe(false);

    const { svc, feedbackQueue } = make();
    feedbackQueue.add.mockRejectedValue(new Error('redis down'));
    expect(await svc.enqueueVote(VOTE)).toBe(false);
  });
});
