import {
  CanActivate,
  ExecutionContext,
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';

/**
 * Protege les routes `/internal/*` - le contrat de service a service du 6 de
 * ../../../../acervatim-docs/agent/backend/architecture-microservices.md.
 *
 * Secret DISTINCT d'`ADMIN_API_TOKEN`, et ce n'est pas de la coquetterie : le jeton admin
 * est manie par un humain (script d'exploitation, curl), celui-ci circule entre processus.
 * Les confondre ferait qu'une fuite du premier - le plus expose des deux - donnerait la
 * suppression de compte de n'importe quel utilisateur via `DELETE /internal/users/:id/data`.
 *
 * Aucune de ces routes n'est exposee par le gateway vers l'exterieur : c'est la premiere
 * ligne de defense, ce garde est la seconde.
 */
@Injectable()
export class InternalGuard implements CanActivate, OnModuleInit {
  private token!: Buffer;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const raw = this.config.get<string>('INTERNAL_SERVICE_TOKEN');
    if (!raw) {
      throw new Error('INTERNAL_SERVICE_TOKEN must be set');
    }
    this.token = Buffer.from(raw);
  }

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers['authorization'];
    const provided = Buffer.from(
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length).trim()
        : '',
    );
    // Comparaison a temps constant ; le test de longueur prealable ne fuit que la
    // longueur, qui est publique.
    if (
      provided.length !== this.token.length ||
      !timingSafeEqual(provided, this.token)
    ) {
      throw new UnauthorizedException('Invalid internal service token');
    }
    return true;
  }
}
