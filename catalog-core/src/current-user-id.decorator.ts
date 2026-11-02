import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import { Request } from 'express';

/**
 * `userId` du requerant, pose par le `PrincipalGuard` du socle.
 *
 * Copie du decorateur du socle plutot qu'un import : `catalog-core` ne connait pas
 * l'arborescence de son consommateur. Trois lignes dupliquees valent mieux qu'une dependance
 * de la bibliotheque vers le `src/` du service qui la charge.
 *
 * Lecture par assertion, pour la meme raison que dans `CollectionAccessGuard` : deux
 * augmentations concurrentes de `express.Request` seraient plus fragiles.
 */
export const CurrentUserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<Request>();
    const userId = (req as unknown as { userId?: string }).userId;
    if (!userId) {
      throw new InternalServerErrorException(
        'CurrentUserId used without PrincipalGuard',
      );
    }
    return userId;
  },
);
