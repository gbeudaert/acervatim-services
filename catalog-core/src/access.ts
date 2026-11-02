import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import { Request } from 'express';
import { SHARE_STATUSES, ShareStatus } from './contracts';

/** Role du requerant sur la collection visee. */
export type CollectionRole = 'owner' | 'shared';

/**
 * Ce que le requerant a le droit de voir de cette collection.
 *
 * **C'est le `CollectionAccess` du monolithe, mais il n'est plus resolu ici.** Dans le
 * monolithe, `CollectionAccessService` lisait `collections` et `collection_share_entries`
 * pour le construire a chaque requete. Depuis le 3.1 et le 3.6, le gateway le resout **une
 * fois** aupres de `sharing` et le propage dans le principal signe : le catalog ne fait plus
 * que le lire.
 *
 * L'invariant qui comptait est preserve, et meme renforce : **les statuts n'ont aucun chemin
 * par lequel arriver du client**. Ils sont dans un jeton signe HMAC que le client ne peut ni
 * forger ni modifier.
 */
export interface CollectionAccess {
  collectionId: string;
  /** Proprietaire de la collection - c'est SON premium qui a conditionne la lecture. */
  ownerUserId: string;
  role: CollectionRole;
  /** Statuts exposes. Un proprietaire les a tous. */
  statuses: ShareStatus[];
}

/** Statuts effectivement lisibles : le proprietaire voit 100 % de sa collection. */
export function accessStatuses(access: CollectionAccess): ShareStatus[] {
  return access.role === 'shared' ? access.statuses : [...SHARE_STATUSES];
}

/**
 * Construit l'acces a partir du principal signe et de la collection visee.
 *
 * Le principal ne porte le couple `role` / `statuses` que sur les routes ou le gateway a
 * resolu un acces - celles qui designent une collection. Ailleurs, le catalog travaille sur
 * les collections du requerant, qui en est donc le proprietaire.
 *
 * Repli **volontairement restrictif** : un principal marque `shared` sans statuts donne un
 * ensemble vide, c'est-a-dire aucune visibilite. Un principal abime ne doit jamais ouvrir
 * plus que prevu ; il doit ne rien ouvrir du tout.
 */
export function accessFromPrincipal(
  principal: { userId: string; role?: CollectionRole; statuses?: string[] },
  collectionId: string,
  ownerUserId: string,
): CollectionAccess {
  if (principal.role === 'shared') {
    const statuses = (principal.statuses ?? []).filter(
      (s): s is ShareStatus => SHARE_STATUSES.includes(s as ShareStatus),
    );
    return { collectionId, ownerUserId, role: 'shared', statuses };
  }
  return {
    collectionId,
    ownerUserId,
    role: 'owner',
    statuses: [...SHARE_STATUSES],
  };
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Pose par `CollectionAccessGuard` du service catalog. */
    collectionAccess?: CollectionAccess;
  }
}

/**
 * Acces resolu de la requete courante. A utiliser UNIQUEMENT sur les routes protegees par
 * le garde qui le pose - sans lui, la valeur est absente et l'erreur doit etre franche
 * plutot que silencieuse.
 */
export const CurrentCollectionAccess = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CollectionAccess => {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.collectionAccess) {
      throw new InternalServerErrorException(
        'CurrentCollectionAccess used without CollectionAccessGuard',
      );
    }
    return req.collectionAccess;
  },
);
