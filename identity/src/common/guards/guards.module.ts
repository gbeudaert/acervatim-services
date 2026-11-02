import { Global, Module } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { InternalGuard } from './internal.guard';
import { PrincipalGuard } from './principal.guard';

/**
 * Les trois gardes sont sans etat une fois initialisees et lisent la meme configuration.
 * Les fournir globalement evite qu'un module qui en a besoin les re-instancie - quatre
 * copies du meme garde relisaient la config au boot.
 *
 * Trois portes distinctes, trois publics : `PrincipalGuard` pour l'utilisateur (via le
 * gateway ou le JWT), `InternalGuard` pour un service voisin, `AdminGuard` pour un humain
 * d'exploitation.
 */
@Global()
@Module({
  providers: [PrincipalGuard, AdminGuard, InternalGuard],
  exports: [PrincipalGuard, AdminGuard, InternalGuard],
})
export class GuardsModule {}
