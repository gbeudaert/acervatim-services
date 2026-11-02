export type LegoProvider = 'rebrickable' | 'brickset';

export interface ResolvedToken {
  key: string;
  /** `user` = cle personnelle (BYOT) ; `acervatim` = cle serveur, reservee au premium. */
  origin: 'user' | 'acervatim';
}

/**
 * Port de resolution de jeton. Une seule logique, celle deja actee dans le monolithe
 * (`TokenResolverService`) et decrite dans ../acervatim-docs/agent/transverse/sources-externes.md :
 *
 *   1. jeton utilisateur (BYOT) present -> on l'utilise ;
 *   2. sinon premium -> cle serveur Acervatim, sous debit partage ;
 *   3. sinon -> mode degrade : `null`, l'appelant sert le cache et l'index local, ou leve
 *      `SourceTokenRequiredException`.
 *
 * C'est un **port** parce que, dans la cible, ces credentials appartiennent au service
 * `connections` et se resolvent par `GET /internal/token/:userId/:provider` (6 de
 * architecture-microservices.md). Le jour ou `connections` existe, on substitue une
 * implementation HTTP ; aucun appelant ne change.
 */
export abstract class TokenResolverPort {
  abstract resolve(
    userId: string,
    provider: LegoProvider,
    premium: boolean,
  ): Promise<ResolvedToken | null>;
}
