import { Global, Module } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { PrincipalGuard } from './principal.guard';

/**
 * Les deux gardes sont sans etat une fois initialisees et lisent la meme configuration.
 * Les fournir globalement evite qu'un module qui en a besoin les re-instancie - quatre
 * copies du meme garde relisaient la config au boot.
 */
@Global()
@Module({
  providers: [PrincipalGuard, AdminGuard],
  exports: [PrincipalGuard, AdminGuard],
})
export class GuardsModule {}
