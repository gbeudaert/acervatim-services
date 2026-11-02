import {
  ExecutionContext,
  createParamDecorator,
  InternalServerErrorException,
} from '@nestjs/common';
import { Request } from 'express';
import { Principal } from '../guards/principal.types';

/** Principal complet (dont `premium`), pose par `PrincipalGuard`. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal => {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.principal) {
      throw new InternalServerErrorException(
        'CurrentPrincipal used without PrincipalGuard',
      );
    }
    return req.principal;
  },
);
