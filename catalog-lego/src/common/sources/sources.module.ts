import { Global, Module } from '@nestjs/common';
import { LocalTokenResolver } from './local-token-resolver.service';
import { TokenResolverPort } from './token-resolver.port';

/**
 * Cablage du port de resolution de jeton. Le jour ou `connections` existe, seule la ligne
 * `useClass` change - c'est tout l'interet d'avoir nomme un port plutot qu'un service.
 */
@Global()
@Module({
  providers: [{ provide: TokenResolverPort, useClass: LocalTokenResolver }],
  exports: [TokenResolverPort],
})
export class SourcesModule {}
