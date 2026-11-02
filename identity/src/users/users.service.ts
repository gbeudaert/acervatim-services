import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuditLogService } from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { DeletionSagaService } from '../saga/deletion-saga.service';
import { ExportFanoutService } from '../saga/export-fanout.service';

export interface UserMe {
  userId: string;
  createdAt: Date;
}

/**
 * Forme de l'export RGPD. **Identique a celle du monolithe** : les cles `collections`,
 * `items`, `subscription`... viennent maintenant de services differents, mais un export est
 * fait pour etre relu par un outil tiers, et changer sa structure casserait ce relecteur
 * pour une raison qui ne le regarde pas.
 *
 * `incomplete` est le seul ajout : un fragment manquant doit se voir. Un export ampute
 * servi comme complet serait pire qu'un export refuse.
 */
export interface UserExport {
  exportedAt: string;
  schemaVersion: number;
  /** Services qui n'ont pas repondu. Vide en fonctionnement nominal. */
  incomplete: string[];
  data: Record<string, unknown>;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly saga: DeletionSagaService,
    private readonly exportFanout: ExportFanoutService,
  ) {}

  async findById(userId: string): Promise<UserMe> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, createdAt: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return { userId: user.id, createdAt: user.createdAt };
  }

  /**
   * RGPD art. 20. On consigne l'export AVANT le fetch, pour qu'une lecture cassee laisse
   * quand meme une trace - inchange depuis le monolithe.
   *
   * Ce qui change : les donnees de domaine viennent d'un fan-out (3.4). identity ne detient
   * plus que le compte et son journal d'audit.
   */
  async exportMe(userId: string): Promise<UserExport> {
    await this.auditLog.record({ userId, action: 'user.export' });

    const [user, auditLogs, fanout] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, createdAt: true, updatedAt: true },
      }),
      this.prisma.auditLog.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      }),
      this.exportFanout.collect(userId),
    ]);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      exportedAt: new Date().toISOString(),
      schemaVersion: 1,
      incomplete: fanout.incomplete,
      data: { user, ...fanout.fragments, auditLogs },
    };
  }

  /**
   * Supprime le compte et declenche la saga. Voir {@link DeletionSagaService} pour la
   * raison pour laquelle le compte part meme si un participant echoue.
   *
   * La reponse expose `pending` : l'utilisateur - et surtout l'exploitation - doivent
   * pouvoir constater qu'une suppression n'est pas encore complete, plutot que de le
   * decouvrir dans un journal.
   */
  async deleteMe(
    userId: string,
  ): Promise<{ deleted: true; pending: string[] }> {
    const outcome = await this.saga.deleteUser(userId);
    return { deleted: true, pending: outcome.pending };
  }
}
