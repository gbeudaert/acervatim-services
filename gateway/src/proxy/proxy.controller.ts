import {
  All,
  Controller,
  Logger,
  MethodNotAllowedException,
  NotFoundException,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { ZodValidationException } from 'nestjs-zod';
import { ZodError } from 'zod';
import { AdminGuard } from '../common/guards/admin.guard';
import { PrincipalService } from '../principal/principal.service';
import { RegistryService } from '../registry/registry.service';
import { allowedMethods, matchRoute, pathExists } from '../routing/route-matcher';
import { ServiceRegistryService } from '../routing/service-registry.service';
import { ProxyService } from './proxy.service';
import { RouteThrottleService } from './route-throttle.service';
import {
  ScatterGatherService,
  ScatterGatherUpstreamError,
} from './scatter-gather.service';

/** Prefixes servis par le gateway lui-meme : ils ne partent jamais en aval. */
const LOCAL_PREFIXES = ['/health', '/internal', '/docs', '/openapi.json'];

/**
 * Point d'entree unique du contrat `/v1/*`.
 *
 * Un seul controleur attrape-tout plutot qu'un controleur par famille de routes : le
 * gateway n'implemente aucun metier, il applique une table (`route-table.ts`). Declarer
 * trente methodes vides qui appellent toutes `forward` donnerait l'illusion d'un domaine
 * la ou il n'y en a pas, et ferait diverger la table de son application.
 */
@ApiExcludeController()
@Controller()
export class ProxyController {
  private readonly logger = new Logger(ProxyController.name);

  constructor(
    private readonly proxy: ProxyService,
    private readonly principal: PrincipalService,
    private readonly registry: RegistryService,
    private readonly services: ServiceRegistryService,
    private readonly scatter: ScatterGatherService,
    private readonly adminGuard: AdminGuard,
    private readonly throttle: RouteThrottleService,
  ) {}

  @All('*')
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const path = (req.originalUrl ?? req.url).split('?')[0];

    // Filet de securite : ces chemins ont leurs propres controleurs, enregistres avant
    // celui-ci. S'ils arrivent ici, c'est qu'ils n'existent pas.
    if (LOCAL_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) {
      throw new NotFoundException('Not found');
    }

    const match = matchRoute(req.method, path);
    if (!match) {
      // Une route connue appelee avec le mauvais verbe n'est pas une route inconnue :
      // repondre 404 aux deux rendrait une erreur de client indiscernable d'une faute
      // de frappe dans l'URL.
      if (pathExists(path)) {
        res.setHeader('Allow', allowedMethods(path).join(', '));
        throw new MethodNotAllowedException(
          `${req.method} not allowed on this resource`,
        );
      }
      throw new NotFoundException('Not found');
    }

    // Debit avant authentification : un client qui martele une route protegee doit etre
    // freine sans qu'on paie une verification de signature a chaque coup.
    this.throttle.assertWithinLimit(req, match.rule);

    if (match.rule.auth === 'admin') {
      // Verifie a la main : le garde ne peut pas etre pose par decorateur sur une route
      // attrape-tout dont le regime d'authentification depend de la table.
      this.adminGuard.canActivate({
        switchToHttp: () => ({ getRequest: () => req }),
      } as never);
    }

    // Le registre est consulte AVANT la resolution du principal : celle-ci a besoin de
    // savoir quelle collection est visee pour interroger `sharing` (3.1 et 3.3).
    const target = match.rule.target;
    let catalogService = undefined as ReturnType<
      ServiceRegistryService['catalogForType']
    > | undefined;

    if (target.kind === 'catalog:ref') {
      const resolved = await this.resolveByRegistry(
        target.via,
        match.params[target.param],
      );
      // Ressource absente du registre : 404, sans distinguer « jamais existe » de
      // « registre divergent ». Le job de reparation existe precisement parce que ce 404
      // est indetectable autrement (3.3).
      if (!resolved) throw new NotFoundException('Resource not found');
      req.resolvedCollectionId = resolved.collectionId;
      catalogService = this.services.catalogForType(resolved.typeCode);
    }

    const resolvedRequest = await this.principal.resolve(req, match);

    switch (target.kind) {
      case 'service':
        await this.proxy.forward(
          this.services.require(target.service),
          req,
          res,
          resolvedRequest.principalHeader,
          undefined,
          { forwardAuthorization: match.rule.forwardAuthorization },
        );
        return;

      case 'catalog:ref':
        await this.proxy.forward(
          this.services.require(catalogService!),
          req,
          res,
          resolvedRequest.principalHeader,
        );
        return;

      case 'catalog:body-type':
        await this.proxy.forward(
          this.services.require(this.catalogFromBody(req)),
          req,
          res,
          resolvedRequest.principalHeader,
        );
        return;

      case 'catalog:scatter':
        await this.handleScatter(req, res, resolvedRequest.principalHeader);
        return;
    }
  }

  private async resolveByRegistry(
    via: 'collection' | 'item' | 'node',
    id: string,
  ) {
    if (via === 'collection') return this.registry.findCollection(id);
    return this.registry.findResourceCollection(id, via);
  }

  /**
   * `POST /v1/collections` n'a pas encore d'identifiant : le type vient du corps. C'est le
   * seul endroit ou le gateway regarde une charge utile, et il n'en lit qu'un champ.
   */
  private catalogFromBody(req: Request) {
    const body = req.body as { typeCode?: unknown } | undefined;
    const typeCode = typeof body?.typeCode === 'string' ? body.typeCode : '';
    if (!typeCode) {
      // Laisser le catalog rendre l'erreur serait plus homogene, mais sans `typeCode` il n'y
      // a aucun catalog vers qui router : le refus doit venir d'ici.
      //
      // On leve une **vraie** `ZodValidationException` plutot qu'un `BadRequestException` :
      // le filtre RFC 9457 la reconnait et produit `/probs/validation-error` avec son tableau
      // `errors[]`, exactement ce que le catalog aurait rendu. Un `BadRequestException`
      // sortirait sous une autre URI `type`, et l'app discrimine dessus.
      throw new ZodValidationException(
        new ZodError([
          {
            code: 'invalid_type',
            expected: 'string',
            received: body?.typeCode === undefined ? 'undefined' : 'unknown',
            path: ['typeCode'],
            message: 'Required',
          },
        ]),
      );
    }
    return this.services.catalogForType(typeCode);
  }

  private async handleScatter(
    req: Request,
    res: Response,
    principalHeader: string | undefined,
  ): Promise<void> {
    try {
      const page = await this.scatter.listCollections(req, principalHeader);
      if (req.requestId) res.setHeader('X-Request-Id', req.requestId);
      res.status(200).json(page);
    } catch (err) {
      if (err instanceof ScatterGatherUpstreamError) {
        // Le Problem Details du catalog est relaye tel quel : l'app discrimine deja sur
        // ces URI, et les reemballer ferait apparaitre une erreur de gateway la ou c'est
        // une erreur de catalog.
        res.setHeader('Content-Type', 'application/problem+json');
        res.status(err.status).send(err.body);
        return;
      }
      throw err;
    }
  }
}
