import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { ApiCacheService } from '../../common/cache/api-cache.service';
import { GAMEUPC_CLIENT, GameUpcClient, GameUpcError } from './gameupc.client';
import { pauseOnRateLimit } from './gameupc.processor';
import {
  CachedGameUpcLookup,
  GAMEUPC_FEEDBACK_LIMITER,
  GAMEUPC_FEEDBACK_QUEUE,
  GameUpcVoteJobData,
  GameUpcVoteOutcome,
  LAST_KNOWN_TTL_SECONDS,
  lastKnownCacheKey,
  lookupCacheKey,
  lookupTtlSeconds,
} from './gameupc.types';

/**
 * File de feedback : envoie à GameUPC le choix d'un utilisateur, pour que le code soit vérifié
 * pour les suivants. C'est ce qui fait progresser la couverture des EAN français, presque tous
 * non vérifiés aujourd'hui.
 *
 * **Idempotence.** GameUPC garde un vote par (code, votant) : renvoyer le même vote ne change rien,
 * et le job peut donc être rejoué sans risque (worker tué entre l'appel et l'acquittement, rejeu
 * BullMQ). Le doublon côté Acervatim est absorbé en amont par le `jobId` (cf. `voteJobId`).
 *
 * **Retry.** `429` et indisponibilité : le job échoue et BullMQ le retente avec un backoff long
 * (cf. `GameUpcService.enqueueVote`), après avoir mis la file en pause sur un `429`. Un refus
 * (`400`, clé refusée, réponse illisible) ne se retente pas : `UnrecoverableError`, le job reste
 * visible en échec dans `/v1/admin/queues`.
 *
 * **Ordre.** Un vote retenté peut arriver après un choix plus récent du même utilisateur, déjà
 * envoyé : le renvoyer l'écraserait. Sur une nouvelle tentative seulement, on relit donc le vote
 * enregistré et on s'abstient s'il est postérieur au choix (`superseded`) — ou déjà identique,
 * quand la tentative précédente a abouti sans que sa réponse nous parvienne.
 */
@Processor(GAMEUPC_FEEDBACK_QUEUE, {
  concurrency: 1,
  limiter: GAMEUPC_FEEDBACK_LIMITER,
})
export class GameUpcFeedbackProcessor extends WorkerHost {
  private readonly logger = new Logger(GameUpcFeedbackProcessor.name);

  constructor(
    @Inject(GAMEUPC_CLIENT) private readonly client: GameUpcClient,
    private readonly cache: ApiCacheService,
  ) {
    super();
  }

  async process(
    job: Job<GameUpcVoteJobData, GameUpcVoteOutcome>,
  ): Promise<GameUpcVoteOutcome> {
    const vote = job.data;
    try {
      if (job.attemptsMade > 0) {
        const recorded = await this.client.recordedVote(vote.upc, vote.voterId);
        if (recorded) {
          const same =
            recorded.bggId === vote.bggId &&
            recorded.versionId === vote.versionId;
          if (same) return 'sent';
          if (Date.parse(recorded.recordedAt) > Date.parse(vote.chosenAt)) {
            this.logger.log(
              `gameupc: vote superseded upc=${vote.upc} bggId=${vote.bggId}`,
            );
            return 'superseded';
          }
        }
      }

      const info = await this.client.vote(vote);
      // La réponse est l'état public du code après le vote : elle remplace la consultation cachée.
      const entry: CachedGameUpcLookup = {
        info,
        fetchedAt: new Date().toISOString(),
      };
      await this.cache.set(
        lookupCacheKey(vote.upc, null),
        entry,
        lookupTtlSeconds(info),
      );
      await this.cache.set(
        lastKnownCacheKey(vote.upc),
        entry,
        LAST_KNOWN_TTL_SECONDS,
      );
      return 'sent';
    } catch (err) {
      if (err instanceof GameUpcError && !err.retryable) {
        throw new UnrecoverableError(
          `gameupc: vote refused (${err.kind}): ${err.message}`,
        );
      }
      await pauseOnRateLimit(this.worker, err);
      throw err;
    }
  }
}
