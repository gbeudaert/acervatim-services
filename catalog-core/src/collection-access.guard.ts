import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { accessFromPrincipal, CollectionRole } from './access';
import { CATALOG_DB, CatalogDb } from './db';

/** Par quel identifiant la route designe sa collection. */
export type CollectionRefVia = 'collection' | 'item' | 'node';

export const COLLECTION_REF = 'collection-ref';

/**
 * Declare d'ou vient l'identifiant de la collection visee par la route.
 *
 * C'est le `@CollectionRef` du monolithe, avec un role reduit : il ne sert plus a **resoudre
 * un acces** - le gateway l'a fait, et le principal signe le porte - mais seulement a
 * retrouver la collection dans les tables locales pour poser `ownerUserId`.
 */
export const CollectionRef = (via: CollectionRefVia, param: string) =>
  SetMetadata(COLLECTION_REF, { via, param });

/**
 * Pose `req.collectionAccess` a partir du principal signe et de la collection visee.
 *
 * ### Ce que ce garde ne fait plus
 *
 * Dans le monolithe, `CollectionPremiumGuard` et `CollectionWriteGuard` faisaient trois
 * choses : resoudre la collection, resoudre l'acces (proprietaire ou membre, avec ses
 * statuts), et verifier le premium du proprietaire. Les deux dernieres sont remontees au
 * gateway (3.1 et 3.6) : quand la requete arrive ici, la decision est **deja prise** et
 * signee. Il ne reste qu'a lire.
 *
 * Ce garde ne redecide donc pas l'acces : il ne consulte pas les partages et ne refait pas le
 * calcul des statuts. C'est voulu : deux endroits qui decident du meme acces finissent
 * toujours par ne plus dire la meme chose.
 *
 * ### Ce qu'il refuse encore, en `404`
 *
 * - **La ressource n'existe pas dans ce catalog.** Ce n'est pas redondant avec le registre du
 *   gateway : une ressource peut avoir disparu entre la resolution du registre et l'arrivee
 *   ici, et le registre peut diverger. La verite est dans ces tables.
 * - **Un principal qui n'est pas marque `shared` et n'est pas le proprietaire.** C'est une
 *   defense en profondeur, decidee le 2026-11-18 : le gateway a deja refuse ce tiers, apres
 *   `sharing`, et ce test ne change rien a un usage normal. Il ne tranche aucune question de
 *   partage - il verifie seulement que le principal dit vrai sur ce que ces tables savent
 *   sans `sharing` : qui possede la collection. Sans lui, un principal signe sans role (une
 *   route du gateway mal declaree, par exemple) ouvrirait la collection de n'importe qui en
 *   lecture.
 *
 * Le refus est un `404`, jamais un `403`, comme au gateway : un tiers ne doit pas pouvoir
 * distinguer une collection qui existe d'une collection qui n'existe pas.
 */
@Injectable()
export class CollectionAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(CATALOG_DB) private readonly prisma: CatalogDb,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.get<{ via: CollectionRefVia; param: string }>(
      COLLECTION_REF,
      ctx.getHandler(),
    );
    if (!meta) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    // Lu par assertion plutot que par declaration merge : `Principal` est declare dans le
    // socle de chaque service, que `catalog-core` ne peut pas importer. Deux augmentations
    // concurrentes de `express.Request` seraient plus fragiles que cette lecture explicite.
    const principal = (
      req as unknown as {
        principal?: { userId: string; role?: string; statuses?: string[] };
      }
    ).principal;
    if (!principal) {
      // Sans `PrincipalGuard` en amont, il n'y a pas d'identite : c'est une erreur de
      // cablage, pas un refus d'acces.
      throw new Error('CollectionAccessGuard used without PrincipalGuard');
    }

    const rawId = req.params[meta.param];
    const collection = await this.resolveCollection(meta.via, rawId);
    if (!collection) {
      throw new NotFoundException('Resource not found');
    }
    if (principal.role !== 'shared' && principal.userId !== collection.userId) {
      throw new NotFoundException('Resource not found');
    }

    req.collectionAccess = accessFromPrincipal(
      {
        userId: principal.userId,
        role: principal.role as CollectionRole | undefined,
        statuses: principal.statuses,
      },
      collection.id,
      collection.userId,
    );
    return true;
  }

  private async resolveCollection(
    via: CollectionRefVia,
    id: string,
  ): Promise<{ id: string; userId: string } | null> {
    if (!id) return null;
    if (via === 'collection') {
      return this.prisma.collection.findUnique({
        where: { id },
        select: { id: true, userId: true },
      });
    }
    if (via === 'item') {
      const item = await this.prisma.item.findUnique({
        where: { id },
        select: { collection: { select: { id: true, userId: true } } },
      });
      return item?.collection ?? null;
    }
    const node = await this.prisma.collectionNode.findUnique({
      where: { id },
      select: { collection: { select: { id: true, userId: true } } },
    });
    return node?.collection ?? null;
  }
}
