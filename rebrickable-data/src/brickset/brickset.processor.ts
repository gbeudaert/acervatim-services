import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { HttpClientService } from '../common/http/http-client.service';
import { BRICKSET_QUEUE, BricksetFetchJobData } from './brickset.types';

/**
 * Seul point qui interroge reellement Brickset.
 *
 * `concurrency: 1` et un limiter tres bas : la contrainte de Brickset n'est pas un debit
 * instantane mais un **quota journalier** (100 appels `getSets` sur une cle libre). Le budget
 * est donc gere en amont par `BricksetService` ; ici on se contente de garantir qu'aucune rafale
 * ne parte, y compris si plusieurs jobs sont enfiles par erreur.
 *
 * **Une seule tentative HTTP par job** (`maxAttempts: 1`) : le budget compte une unite par job,
 * et chaque nouvelle tentative du client HTTP serait un appel reel de plus, invisible du
 * compteur. Une page en echec est reprise par la campagne suivante, qui la recompte.
 *
 * La cle API est ajoutee **ici**, depuis la configuration : le payload du job (stocke dans
 * Redis) ne porte que les parametres `getSets`.
 *
 * Ce worker ne sert **jamais** une requete utilisateur : il n'alimente que le moissonneur.
 */
@Processor(BRICKSET_QUEUE, {
  concurrency: 1,
  limiter: { max: 1, duration: 2000 },
})
export class BricksetProcessor extends WorkerHost {
  constructor(
    private readonly http: HttpClientService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<BricksetFetchJobData, unknown>): Promise<unknown> {
    const res = await this.http.request<unknown>(this.getSetsUrl(job.data), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      maxAttempts: 1,
    });
    return res.data;
  }

  getSetsUrl(data: BricksetFetchJobData): string {
    const apiKey = this.config.get<string>('BRICKSET_API_KEY');
    if (!apiKey) throw new Error('brickset: BRICKSET_API_KEY absent');
    const baseUrl = this.config
      .get<string>('BRICKSET_BASE_URL')!
      .replace(/\/+$/, '');
    const query = new URLSearchParams({
      apiKey,
      userHash: '',
      params: JSON.stringify(data.params),
    });
    return `${baseUrl}/getSets?${query.toString()}`;
  }
}
