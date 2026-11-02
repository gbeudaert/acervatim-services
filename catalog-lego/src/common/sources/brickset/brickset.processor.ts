import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { HttpClientService } from '../../http/http-client.service';
import { BRICKSET_QUEUE, BricksetFetchJobData } from './brickset.types';

/**
 * Seul point qui interroge reellement Brickset.
 *
 * `concurrency: 1` et un limiter tres bas : la contrainte de Brickset n'est pas un debit
 * instantane mais un **quota journalier** (100 appels `getSets` sur une cle libre). Le budget
 * est donc gere en amont par `BricksetService` ; ici on se contente de garantir qu'aucune rafale
 * ne parte, y compris si plusieurs jobs sont enfiles par erreur.
 *
 * Ce worker ne sert **jamais** une requete utilisateur : il n'alimente que le moissonneur.
 */
@Processor(BRICKSET_QUEUE, {
  concurrency: 1,
  limiter: { max: 1, duration: 2000 },
})
export class BricksetProcessor extends WorkerHost {
  constructor(private readonly http: HttpClientService) {
    super();
  }

  async process(job: Job<BricksetFetchJobData, unknown>): Promise<unknown> {
    const res = await this.http.request<unknown>(job.data.url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    return res.data;
  }
}
