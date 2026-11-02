import { Injectable, Logger } from '@nestjs/common';
import { InternalUserExportFragment } from '../common/internal/contracts';
import { InternalClientService } from '../common/internal/internal-client.service';
import { SagaParticipantsService } from './saga-participants.service';

const EXPORT_TIMEOUT_MS = 20_000;

/**
 * Fan-out de l'export RGPD (3.4 de architecture-microservices.md).
 *
 * `GET /v1/me/export` agregait des tables voisines dans le monolithe ; il agrege desormais N
 * reponses. **La forme du payload ne change pas** : c'est une contrainte du contrat public,
 * pas un detail - un export dont la structure change casse tout outil qui le relit, et un
 * export RGPD est precisement fait pour etre relu ailleurs.
 *
 * Un participant injoignable ne fait pas echouer l'export : son fragment est marque en
 * erreur et le reste est servi. Refuser tout l'export parce qu'un service est en panne
 * priverait l'utilisateur d'un droit pour une raison qui ne le concerne pas - mais lui
 * livrer un export incomplet **sans le dire** serait pire, d'ou le marqueur explicite.
 */
@Injectable()
export class ExportFanoutService {
  private readonly logger = new Logger(ExportFanoutService.name);

  constructor(
    private readonly internal: InternalClientService,
    private readonly participants: SagaParticipantsService,
  ) {}

  async collect(userId: string): Promise<{
    fragments: Record<string, unknown>;
    incomplete: string[];
  }> {
    const results = await Promise.all(
      this.participants.all().map(async (p) => {
        const fragment =
          await this.internal.tryRequest<InternalUserExportFragment>(
            p.baseUrl,
            `/internal/users/${encodeURIComponent(userId)}/export`,
            { timeoutMs: EXPORT_TIMEOUT_MS },
          );
        return { name: p.name, fragment };
      }),
    );

    const fragments: Record<string, unknown> = {};
    const incomplete: string[] = [];
    for (const { name, fragment } of results) {
      if (!fragment) {
        incomplete.push(name);
        this.logger.warn(`export RGPD incomplet : ${name} injoignable`);
        continue;
      }
      // On aplatit les cles du fragment dans le payload : c'est ce qui preserve la forme
      // historique (`collections`, `items`, `subscription`, ...) plutot que d'introduire un
      // niveau `parService` qui serait un changement de contrat.
      Object.assign(fragments, fragment.data ?? {});
    }
    return { fragments, incomplete };
  }
}
