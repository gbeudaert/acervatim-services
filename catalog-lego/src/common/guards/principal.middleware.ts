import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { PrincipalGuard } from './principal.guard';

/**
 * Etablit l'identite du requerant sur les routes `/v1/*`.
 *
 * Un **middleware** et non `PrincipalGuard` pose par `@UseGuards`, pour une raison mecanique :
 * les controleurs du domaine viennent de `@acervatim/catalog-core`, et on ne peut pas
 * decorer un handler qu'on ne declare pas.
 *
 * Un garde **global** (`APP_GUARD`) ne conviendrait pas non plus : il s'appliquerait aussi a
 * `/health/*`, `/internal/*` et `/openapi.json`, qui n'ont pas d'identite a etablir et
 * repondraient alors `401`. Le middleware s'applique par chemin, ce qui donne exactement le
 * perimetre voulu.
 *
 * La logique elle-meme n'est pas dupliquee : `PrincipalGuard.resolve` est le point commun.
 */
@Injectable()
export class PrincipalMiddleware implements NestMiddleware {
  constructor(private readonly guard: PrincipalGuard) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    this.guard.resolve(req);
    next();
  }
}
