import { Global, Module } from '@nestjs/common';
import { AuditClientService } from './audit-client.service';
import { InternalClientService } from './internal-client.service';

/**
 * Client des routes `/internal/*`, expose globalement : sans etat une fois initialise, et
 * injecte par plusieurs modules dans la plupart des services.
 *
 * `AuditClientService` y est fourni partout, y compris dans `identity` qui detient la table :
 * la ou il ecrirait dans sa propre base par un aller-retour HTTP inutile, `identity` injecte
 * son `AuditLogService` local a la place. Le fournir quand meme evite qu'un service oublie de
 * declarer sa dependance le jour ou il se met a journaliser.
 */
@Global()
@Module({
  providers: [InternalClientService, AuditClientService],
  exports: [InternalClientService, AuditClientService],
})
export class InternalModule {}
