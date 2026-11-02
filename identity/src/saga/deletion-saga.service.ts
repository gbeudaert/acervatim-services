import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InternalDeleteUserData } from '../common/internal/contracts';
import { InternalClientService } from '../common/internal/internal-client.service';
import { AuditLogService } from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { SagaParticipantsService } from './saga-participants.service';

/** Une suppression n'attend pas le budget des appels internes courants. */
const DELETE_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS_LOGGED = 20;

export interface DeletionOutcome {
  userId: string;
  /** Participants dont la suppression est confirmee. */
  done: string[];
  /** Participants a rejouer. Le compte est supprime malgre tout - voir le JSDoc. */
  pending: string[];
}

/**
 * Saga de suppression de compte (3.4 de architecture-microservices.md).
 *
 * `onDelete: Cascade` de Prisma ne franchit pas une frontiere de schema : `DELETE /v1/me`
 * devient un fan-out vers N services, chacun exposant un
 * `DELETE /internal/users/:id/data` **idempotent**.
 *
 * ### Pourquoi le compte est supprime meme si un participant echoue
 *
 * Le choix inverse - refuser la suppression tant que tout n'est pas efface - conserverait un
 * compte utilisable dont l'utilisateur a demande la suppression, et lui renverrait une erreur
 * qu'il ne peut pas resoudre. Le RGPD demande l'effacement, pas l'atomicite. On supprime donc
 * le compte, on **trace ce qui reste** dans `user_deletion_jobs`, et le job de reconciliation
 * rejoue jusqu'a aboutir. Les lignes de job survivent au compte (aucune FK vers `users`) :
 * sans cela, supprimer le compte effacerait la trace de ce qu'il reste a supprimer.
 *
 * ### Pourquoi un job de reconciliation, et pas seulement un retry en ligne
 *
 * Un retry en ligne ne survit pas a la mort du processus au milieu du fan-out. La cible
 * **exige** un rejeu periodique et une alerte au-dela d'un seuil d'anciennete : tant que ce
 * mecanisme n'est pas en place et teste, le jalon n'est pas termine.
 */
@Injectable()
export class DeletionSagaService {
  private readonly logger = new Logger(DeletionSagaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly internal: InternalClientService,
    private readonly participants: SagaParticipantsService,
    private readonly auditLog: AuditLogService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Ouvre la saga, tente chaque participant une fois, puis supprime le compte.
   * Les participants non aboutis restent `pending` et seront rejoues.
   */
  async deleteUser(userId: string): Promise<DeletionOutcome> {
    // L'audit est ecrit AVANT toute suppression : une lecture cassee doit quand meme
    // laisser une trace. `audit_logs.userId` n'a pas de FK, la ligne survit au compte.
    await this.auditLog.record({ userId, action: 'user.delete' });

    const all = this.participants.all();
    // Jobs crees avant le premier appel : si le processus meurt maintenant, la
    // reconciliation sait quoi rejouer. Les creer apres coup rendrait la fenetre muette.
    await this.prisma.$transaction(
      all.map((p) =>
        this.prisma.userDeletionJob.upsert({
          where: { userId_service: { userId, service: p.name } },
          create: { userId, service: p.name },
          // Un compte recree puis resupprime rouvre le job plutot que d'en creer un second.
          update: { state: 'pending', lastError: null, completedAt: null },
        }),
      ),
    );

    const results = await Promise.all(
      all.map(async (p) => ({
        name: p.name,
        ok: await this.runParticipant(userId, p.name),
      })),
    );

    // Le compte part en dernier : tant qu'il existe, un rejeu peut encore etre attribue.
    try {
      await this.prisma.user.delete({ where: { id: userId } });
    } catch (err) {
      // P2025 = introuvable. Idempotent : un double appel ne casse pas.
      if ((err as { code?: string }).code !== 'P2025') throw err;
    }

    const done = results.filter((r) => r.ok).map((r) => r.name);
    const pending = results.filter((r) => !r.ok).map((r) => r.name);
    if (pending.length > 0) {
      this.logger.warn(
        `user.delete user=${userId.slice(0, 8)}... incomplet - a rejouer : ${pending.join(', ')}`,
      );
    } else {
      this.logger.log(`user.delete user=${userId.slice(0, 8)}... complet`);
    }
    return { userId, done, pending };
  }

  /** Une tentative sur un participant. `true` si sa donnee est partie. */
  private async runParticipant(
    userId: string,
    service: string,
  ): Promise<boolean> {
    const participant = this.participants.find(service);
    if (!participant) {
      // Un service retire de la configuration alors que des jobs le visent encore : on ne
      // marque surtout pas `done` - sa donnee est peut-etre toujours la.
      await this.fail(userId, service, 'participant absent de la configuration');
      return false;
    }

    try {
      const res = await this.internal.request<InternalDeleteUserData>(
        participant.baseUrl,
        `/internal/users/${encodeURIComponent(userId)}/data`,
        { method: 'DELETE', timeoutMs: DELETE_TIMEOUT_MS },
      );
      await this.prisma.userDeletionJob.update({
        where: { userId_service: { userId, service } },
        data: {
          state: 'done',
          completedAt: new Date(),
          lastError: null,
          attempts: { increment: 1 },
        },
      });
      this.logger.log(
        `saga: ${service} a supprime ${res?.deleted ?? 0} enregistrement(s)`,
      );
      return true;
    } catch (err) {
      await this.fail(userId, service, (err as Error).message);
      return false;
    }
  }

  private async fail(
    userId: string,
    service: string,
    message: string,
  ): Promise<void> {
    await this.prisma.userDeletionJob.update({
      where: { userId_service: { userId, service } },
      data: {
        state: 'failed',
        lastError: message.slice(0, 2000),
        attempts: { increment: 1 },
      },
    });
  }

  /**
   * Rejeu periodique. Toutes les 15 minutes : assez frequent pour qu'une indisponibilite
   * ordinaire se resorbe dans l'heure, assez espace pour ne pas marteler un service en
   * panne prolongee.
   *
   * `failed` n'est pas terminal - c'est tout l'interet d'une route participante idempotente.
   */
  @Cron('0 */15 * * * *')
  async reconcile(): Promise<{ retried: number; recovered: number }> {
    const due = await this.prisma.userDeletionJob.findMany({
      where: { state: { in: ['pending', 'failed'] } },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });

    let recovered = 0;
    for (const job of due) {
      if (await this.runParticipant(job.userId, job.service)) recovered += 1;
    }

    await this.alertOnStale();
    if (due.length > 0) {
      this.logger.log(
        `saga: ${due.length} job(s) rejoue(s), ${recovered} aboutis`,
      );
    }
    return { retried: due.length, recovered };
  }

  /**
   * Alerte au-dela d'un seuil d'anciennete. Le rejeu seul ne suffit pas : un participant
   * durablement casse produirait un rejeu silencieux toutes les quinze minutes, et la
   * donnee d'un compte supprime resterait en place sans que personne ne le sache.
   */
  private async alertOnStale(): Promise<void> {
    const hours = this.config.get<number>('SAGA_ALERT_AFTER_HOURS', 24);
    const cutoff = new Date(Date.now() - hours * 3600_000);
    const stale = await this.prisma.userDeletionJob.count({
      where: { state: { in: ['pending', 'failed'] }, createdAt: { lt: cutoff } },
    });
    if (stale > 0) {
      this.logger.error(
        `RGPD: ${stale} suppression(s) non terminee(s) depuis plus de ${hours}h - donnees d'un compte supprime toujours en place`,
      );
    }
  }

  /**
   * Etat de la saga, pour l'exploitation. C'est la mesure exigee au 4 avant tout passage de
   * palier : « 0 job non termine au-dela du seuil d'alerte, sur une fenetre d'observation
   * reelle ».
   */
  async status(): Promise<{
    pending: number;
    failed: number;
    stale: number;
    oldest: Date | null;
    recent: Array<{
      userId: string;
      service: string;
      state: string;
      attempts: number;
      lastError: string | null;
    }>;
  }> {
    const hours = this.config.get<number>('SAGA_ALERT_AFTER_HOURS', 24);
    const cutoff = new Date(Date.now() - hours * 3600_000);
    const unfinished = { state: { in: ['pending', 'failed'] } };

    const [pending, failed, stale, oldestJob, recent] = await Promise.all([
      this.prisma.userDeletionJob.count({ where: { state: 'pending' } }),
      this.prisma.userDeletionJob.count({ where: { state: 'failed' } }),
      this.prisma.userDeletionJob.count({
        where: { ...unfinished, createdAt: { lt: cutoff } },
      }),
      this.prisma.userDeletionJob.findFirst({
        where: unfinished,
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      this.prisma.userDeletionJob.findMany({
        where: unfinished,
        orderBy: { createdAt: 'asc' },
        take: MAX_ATTEMPTS_LOGGED,
        select: {
          userId: true,
          service: true,
          state: true,
          attempts: true,
          lastError: true,
        },
      }),
    ]);

    return { pending, failed, stale, oldest: oldestJob?.createdAt ?? null, recent };
  }
}
