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

/** Protege les routes d'exploitation (`/admin/*`) par un jeton partage hors JWT. */
@Injectable()
export class AdminGuard implements CanActivate, OnModuleInit {
  private token!: Buffer;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.token = Buffer.from(this.config.get<string>('ADMIN_API_TOKEN')!);
  }

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
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
      throw new UnauthorizedException('Invalid admin token');
    }
    return true;
  }
}
