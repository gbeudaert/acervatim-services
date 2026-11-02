import {
  ExecutionContext,
  createParamDecorator,
  InternalServerErrorException,
} from '@nestjs/common';
import { Request } from 'express';

/**
 * Extrait `req.userId` pose par `PrincipalGuard`.
 * A utiliser UNIQUEMENT sur des routes protegees par `@UseGuards(PrincipalGuard)`.
 */
export const CurrentUserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.userId) {
      throw new InternalServerErrorException(
        'CurrentUserId used without PrincipalGuard',
      );
    }
    return req.userId;
  },
);
