import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { NextFunction, Request, Response } from 'express';

/**
 * Protege `/internal/*` par le secret de service a service.
 *
 * Un **middleware** et non le `InternalGuard` du socle, pour une raison mecanique : les
 * controleurs internes du catalog sont enregistres par `@acervatim/catalog-core`, et on ne
 * peut pas poser un `@UseGuards` sur un handler qu'on ne declare pas. Le middleware s'applique
 * par chemin, ce qui donne exactement la meme protection sans que la bibliotheque ait a
 * connaitre le socle du service.
 *
 * Meme secret, meme comparaison a temps constant, meme refus que `InternalGuard` - seul le
 * point d'accroche differe.
 */
@Injectable()
export class InternalTokenMiddleware implements NestMiddleware {
  private readonly token: Buffer;

  constructor(config: ConfigService) {
    const raw = config.get<string>('INTERNAL_SERVICE_TOKEN');
    if (!raw) {
      throw new Error('INTERNAL_SERVICE_TOKEN must be set');
    }
    this.token = Buffer.from(raw);
  }

  use(req: Request, _res: Response, next: NextFunction): void {
    const header = req.headers['authorization'];
    const provided = Buffer.from(
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length).trim()
        : '',
    );
    if (
      provided.length !== this.token.length ||
      !timingSafeEqual(provided, this.token)
    ) {
      throw new UnauthorizedException('Invalid internal service token');
    }
    next();
  }
}
