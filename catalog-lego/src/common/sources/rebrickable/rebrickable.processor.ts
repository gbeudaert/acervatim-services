import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { HttpClientService } from '../../http/http-client.service';
import {
  REBRICKABLE_QUEUE,
  RebrickableFetchJobData,
} from './rebrickable.types';

/**
 * Seul point qui interroge reellement Rebrickable.
 *
 * Le limiter materialise la regle publiee par Rebrickable : « one request/sec on average, with
 * some allowance for burst traffic ». On regle donc `max: 1 / duration: 1000` **tous
 * utilisateurs confondus** : le debit sortant est une ressource du service, pas de l'appelant.
 * `concurrency: 2` laisse deux requetes en vol pour absorber la latence sans depasser le debit
 * (le limiter, pas la concurrence, borne le rythme).
 *
 * Consequence a assumer : la cle est **par job**, pas par worker. Une cle utilisateur (BYOT) et
 * la cle serveur partagent donc le meme seau. C'est volontaire tant que le volume est faible ;
 * si le BYOT devient majoritaire, il faudra une file par origine de cle plutot qu'une file par
 * source - le decoupage se fera la, pas dans le service.
 */
@Processor(REBRICKABLE_QUEUE, {
  concurrency: 2,
  limiter: { max: 1, duration: 1000 },
})
export class RebrickableProcessor extends WorkerHost {
  constructor(private readonly http: HttpClientService) {
    super();
  }

  async process(job: Job<RebrickableFetchJobData, unknown>): Promise<unknown> {
    const res = await this.http.request<unknown>(job.data.url, {
      method: 'GET',
      headers: {
        Authorization: `key ${job.data.apiKey}`,
        Accept: 'application/json',
      },
    });
    return res.data;
  }
}
