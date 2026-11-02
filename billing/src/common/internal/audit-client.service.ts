import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalAuditRecord } from './contracts';
import { InternalClientService } from './internal-client.service';

/**
 * Ecriture dans le journal d'audit, qui vit dans `identity` (`acv_core`).
 *
 * Remplace l'`AuditLogService` local du monolithe pour tous les services qui n'ont pas la
 * table. Le journal reste unique apres le decoupage : l'eparpiller rendrait l'export RGPD
 * dependant de huit lectures pour une donnee dont l'interet est d'etre chronologique et
 * complete.
 *
 * **Best-effort, exactement comme dans le monolithe** : les erreurs sont avalees et
 * journalisees. Un echec d'ecriture d'audit doit alerter, pas faire echouer la verification
 * d'un achat ou la creation d'un partage - l'action metier a eu lieu, refuser de la
 * confirmer parce qu'on n'a pas su l'ecrire ailleurs serait une regression franche.
 */
@Injectable()
export class AuditClientService {
  private readonly logger = new Logger(AuditClientService.name);

  constructor(
    private readonly internal: InternalClientService,
    private readonly config: ConfigService,
  ) {}

  async record(input: InternalAuditRecord): Promise<void> {
    const baseUrl = this.config.get<string>('IDENTITY_BASE_URL');
    if (!baseUrl) {
      this.logger.debug(
        `audit ignore (IDENTITY_BASE_URL absent) action=${input.action}`,
      );
      return;
    }
    try {
      await this.internal.request(baseUrl, '/internal/audit', {
        method: 'POST',
        body: input,
      });
    } catch (err) {
      this.logger.error(
        `audit.record echoue action=${input.action}: ${(err as Error).message}`,
      );
    }
  }
}
