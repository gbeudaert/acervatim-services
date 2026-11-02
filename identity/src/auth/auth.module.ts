import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { IdentityResolverService } from './identity-resolver.service';
import { GoogleIdentityProvider } from './providers/google.provider';
import { IDENTITY_PROVIDERS } from './providers/identity-provider.interface';
import { IdentityProviderRegistry } from './providers/identity-provider.registry';

/**
 * Pas de `JwtAuthGuard` exporte, contrairement au monolithe : plus aucun module ne
 * s'authentifie en re-verifiant un JWT. Le gateway le fait une fois et propage un principal
 * signe, que `PrincipalGuard` (socle commun) verifie.
 */
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    IdentityResolverService,
    IdentityProviderRegistry,
    GoogleIdentityProvider,
    // Injection multi-providers : ajouter Apple = l'ajouter ici et dans `providers`.
    {
      provide: IDENTITY_PROVIDERS,
      useFactory: (google: GoogleIdentityProvider) => [google],
      inject: [GoogleIdentityProvider],
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
