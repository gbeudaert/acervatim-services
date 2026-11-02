import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface SagaParticipant {
  name: string;
  baseUrl: string;
}

/**
 * Les services qui detiennent des donnees rattachees a un utilisateur, et que la saga RGPD
 * doit donc solliciter (3.4 de architecture-microservices.md).
 *
 * Declares par configuration (`SAGA_PARTICIPANTS=nom=url,nom=url`) et non en dur. Le phasage
 * fait apparaitre les services un par un ; une liste codee dans le source rendrait chaque
 * palier dependant d'un redeploiement d'identity, et - plus grave - un service oublie dans
 * le source serait indetectable, alors qu'une variable d'environnement se relit.
 *
 * **Un participant absent de cette liste ne recoit jamais de demande de suppression.** C'est
 * la ligne a completer en meme temps qu'on ajoute un service qui stocke un `userId`.
 */
@Injectable()
export class SagaParticipantsService implements OnModuleInit {
  private readonly logger = new Logger(SagaParticipantsService.name);
  private participants: SagaParticipant[] = [];

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const raw = this.config.get<string>('SAGA_PARTICIPANTS', '');
    this.participants = raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const eq = entry.indexOf('=');
        if (eq <= 0) {
          throw new Error(
            `SAGA_PARTICIPANTS: entree invalide "${entry}" (attendu nom=url)`,
          );
        }
        return {
          name: entry.slice(0, eq).trim(),
          baseUrl: entry.slice(eq + 1).trim().replace(/\/+$/, ''),
        };
      });

    if (this.participants.length === 0) {
      // Un avertissement au demarrage, parce qu'une saga sans participant supprime le
      // compte et **rien d'autre** : silencieusement conforme en apparence, non conforme
      // en fait.
      this.logger.warn(
        'SAGA_PARTICIPANTS vide - DELETE /v1/me ne supprimera que le compte, aucune donnee ailleurs',
      );
    } else {
      this.logger.log(
        `saga RGPD : ${this.participants.length} participant(s) - ${this.participants
          .map((p) => p.name)
          .join(', ')}`,
      );
    }
  }

  all(): SagaParticipant[] {
    return [...this.participants];
  }

  find(name: string): SagaParticipant | undefined {
    return this.participants.find((p) => p.name === name);
  }
}
