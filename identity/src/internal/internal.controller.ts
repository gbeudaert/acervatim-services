import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuditLogService } from '../common/audit/audit-log.service';
import { AdminGuard } from '../common/guards/admin.guard';
import { InternalGuard } from '../common/guards/internal.guard';
import {
  InternalDeleteUserData,
  InternalUserExportFragment,
} from '../common/internal/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { DeletionSagaService } from '../saga/deletion-saga.service';

const AuditRecordSchema = z
  .object({
    userId: z.string().uuid().nullable().optional(),
    action: z.string().min(1).max(64),
    target: z.string().max(128).nullable().optional(),
    // Metadonnee bornee : c'est un service voisin qui ecrit, et une charge non plafonnee
    // ferait du journal d'audit un depotoir que l'export RGPD devrait ensuite servir.
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

class AuditRecordDto extends createZodDto(AuditRecordSchema) {}

/**
 * Routes internes d'identity - jamais exposees par le gateway (6 de
 * architecture-microservices.md).
 *
 * identity est l'**orchestrateur** de la saga RGPD, mais il en est aussi un participant :
 * il detient le compte et son journal d'audit. Les deux routes ci-dessous existent donc pour
 * la symetrie du contrat, meme si c'est `UsersService.deleteMe` qui les court-circuite dans
 * le cas nominal.
 */
@ApiExcludeController()
@Controller('internal')
@SkipThrottle()
export class InternalController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly saga: DeletionSagaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Ecriture dans le journal d'audit par un service voisin.
   *
   * `204` sans corps : l'appelant traite cet appel en best-effort et n'a rien a lire. Lui
   * rendre un identifiant l'inciterait a en dependre, alors que la regle - heritee du
   * monolithe - est qu'un echec d'audit alerte sans faire echouer l'action metier.
   */
  @Post('audit')
  @UseGuards(InternalGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async record(@Body() dto: AuditRecordDto): Promise<void> {
    await this.auditLog.record({
      userId: dto.userId ?? null,
      action: dto.action,
      target: dto.target ?? null,
      metadata: dto.metadata,
    });
  }

  /**
   * Idempotent. Le journal d'audit n'est **pas** supprime : il est append-only et sans FK
   * vers `users`, precisement pour survivre au compte. Ce qu'il contient - horodatage,
   * nom d'action, `userId` opaque - ne re-identifie personne sans le pepper, et l'effacer
   * priverait l'exploitation de la preuve que la suppression a bien eu lieu.
   */
  @Delete('users/:userId/data')
  @UseGuards(InternalGuard)
  async deleteUserData(
    @Param('userId') userId: string,
  ): Promise<InternalDeleteUserData> {
    const res = await this.prisma.user.deleteMany({ where: { id: userId } });
    return { deleted: res.count };
  }

  @Get('users/:userId/export')
  @UseGuards(InternalGuard)
  async exportUserData(
    @Param('userId') userId: string,
  ): Promise<InternalUserExportFragment> {
    const [user, auditLogs] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, createdAt: true, updatedAt: true },
      }),
      this.prisma.auditLog.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return { service: 'identity', data: { user, auditLogs } };
  }

  /**
   * Etat de la saga. Sous `AdminGuard` : c'est une mesure d'exploitation, celle que le 4
   * exige avant tout passage de palier - « 0 job non termine au-dela du seuil d'alerte ».
   */
  @Get('saga/deletions')
  @UseGuards(AdminGuard)
  async sagaStatus() {
    return this.saga.status();
  }

  /** Rejeu immediat, sans attendre le passage aux quinze minutes. */
  @Get('saga/deletions/retry')
  @UseGuards(AdminGuard)
  async retry() {
    return this.saga.reconcile();
  }
}
