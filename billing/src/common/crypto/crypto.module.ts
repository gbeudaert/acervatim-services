import { Global, Module } from '@nestjs/common';
import { AesService } from './aes.service';
import { HashService } from './hash.service';

/**
 * `AesService` chiffre les secrets reversibles (jetons de sources externes) ;
 * `HashService` hache les identifiants et les codes, qui ne se relisent jamais.
 * Les deux sont fournis partout, mais tout service n'a pas ENCRYPTION_KEY : `AesService`
 * ne leve qu'a l'initialisation du module qui l'utilise reellement.
 */
@Global()
@Module({
  providers: [AesService, HashService],
  exports: [AesService, HashService],
})
export class CryptoModule {}
