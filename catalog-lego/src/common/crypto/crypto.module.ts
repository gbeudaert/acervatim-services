import { Global, Module } from '@nestjs/common';
import { AesService } from './aes.service';

/**
 * Pas de `HashService` ici : le hachage du `sub` Google appartient a `identity`.
 * Ce service ne voit jamais qu'un `userId` deja opaque.
 */
@Global()
@Module({
  providers: [AesService],
  exports: [AesService],
})
export class CryptoModule {}
