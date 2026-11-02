import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import jwt from 'jsonwebtoken';
import { PaymentRequiredException } from '../common/errors';
import { encodePrincipal } from '../common/guards/principal.codec';
import { Principal } from '../common/guards/principal.types';
import { ShareStatus } from '../common/internal/contracts';
import { RouteMatch } from '../routing/route-matcher';
import { AccessResolverService } from './access-resolver.service';
import { PremiumCacheService } from './premium-cache.service';

const JWT_ALGORITHM = 'RS256';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ce que le gateway a etabli d'une requete, avant de la transmettre. */
export interface ResolvedRequest {
  /** `undefined` sur une route publique. */
  userId?: string;
  /** En-tete `X-Acervatim-Principal` a poser, ou `undefined` sur une route publique. */
  principalHeader?: string;
  /** Collection visee, quand la route en designe une. Sert a choisir le catalog. */
  collectionId?: string;
}

/**
 * Etablit l'identite et les droits d'une requete, **une seule fois**, puis les signe (3.6).
 *
 * C'est ici que vivent les trois gardes que le monolithe posait sur ses controllers
 * (`PremiumGuard`, `CollectionPremiumGuard`, `CollectionWriteGuard`) : le decoupage les
 * remonte au gateway, seul endroit qui puisse encore interroger `billing` et `sharing` sans
 * qu'un service aval ait a connaitre l'autre. Les codes de refus sont ceux d'api-endpoints.md,
 * et ils ne sont pas interchangeables :
 *
 * | Cas                          | Reponse |
 * |------------------------------|---------|
 * | Ni proprietaire ni membre    | `404` - on ne confirme pas l'existence d'une ressource d'autrui |
 * | Membre d'un partage, en ecriture | `403` - il **voit** deja la ressource, un 404 mentirait sur ce qu'il lit |
 * | Proprietaire non premium     | `402` - y compris pour ses membres : perdre le premium *suspend* les partages |
 * | Identifiant malforme         | `400` |
 */
@Injectable()
export class PrincipalService implements OnModuleInit {
  private readonly logger = new Logger(PrincipalService.name);
  private jwtPublicKey!: string;
  private secret!: string;
  private ttlSeconds!: number;

  constructor(
    private readonly config: ConfigService,
    private readonly premium: PremiumCacheService,
    private readonly access: AccessResolverService,
  ) {}

  onModuleInit(): void {
    // Meme convention que le monolithe : cle sur une ligne, newlines echappees. Sans ce
    // desechappement, `jwt.verify` refuse un PEM pourtant valide.
    this.jwtPublicKey = this.config
      .get<string>('JWT_PUBLIC_KEY')!
      .split('\\n')
      .join('\n');
    this.secret = this.config.get<string>('INTERNAL_PRINCIPAL_SECRET')!;
    this.ttlSeconds = this.config.get<number>('INTERNAL_PRINCIPAL_TTL', 120);
  }

  /**
   * Applique la regle de route et produit ce qu'il faut transmettre a l'aval.
   * Leve l'exception correspondant au refus ; ne renvoie jamais un refus en valeur.
   */
  async resolve(req: Request, match: RouteMatch): Promise<ResolvedRequest> {
    const { rule } = match;

    if (rule.auth === 'public') {
      return {};
    }
    if (rule.auth === 'admin') {
      // Le jeton admin est verifie par `AdminGuard` en amont ; il n'y a pas d'utilisateur
      // a resoudre, et surtout pas de principal a signer : une route d'exploitation ne
      // doit pas pouvoir se faire passer pour un compte.
      return {};
    }

    const userId = this.verifyJwt(req);

    if (rule.premium === 'requester') {
      if (!(await this.premium.isPremium(userId))) {
        throw new PaymentRequiredException();
      }
      return {
        userId,
        principalHeader: this.mint({ userId, premium: true }),
      };
    }

    if (rule.premium === 'owner') {
      return this.resolveCollectionScoped(req, match, userId);
    }

    // `premium: 'none'` - le statut reste transmis, parce qu'un service aval peut en avoir
    // besoin pour une decision qui n'est pas un refus d'acces (mode degrade d'une source,
    // par exemple). Le resoudre ici evite qu'il le fasse lui-meme.
    const premium = await this.premium.isPremium(userId);
    return { userId, principalHeader: this.mint({ userId, premium }) };
  }

  /** Le chemin des routes qui designent une collection : les deux gardes a `@CollectionRef`. */
  private async resolveCollectionScoped(
    req: Request,
    match: RouteMatch,
    userId: string,
  ): Promise<ResolvedRequest> {
    const target = match.rule.target;
    if (target.kind !== 'catalog:ref') {
      throw new Error(
        `route ${match.rule.pattern} : premium 'owner' exige une cible catalog:ref`,
      );
    }
    const rawId = match.params[target.param];
    // Le monolithe laissait `ParseUUIDPipe` refuser un identifiant malforme en 400 ;
    // le gateway doit le faire avant de router, sinon il chercherait dans le registre
    // une cle qui ne peut pas y etre et repondrait 404 - un code different pour la
    // meme faute de client.
    if (!UUID_RE.test(rawId)) {
      throw new BadRequestException(
        `Validation failed (uuid is expected for '${target.param}')`,
      );
    }

    // Le resolveur de collection est branche par le controleur de proxy, qui connait le
    // registre. Ici on ne fait que consommer ce qu'il a pose.
    const collectionId = req.resolvedCollectionId;
    if (!collectionId) {
      throw new NotFoundException('Resource not found');
    }

    const access = await this.access.resolve(
      userId,
      collectionId,
      req.requestId,
    );
    // Ni proprietaire ni membre : 404, et rien de plus.
    if (!access) {
      throw new NotFoundException('Resource not found');
    }
    // Un membre voit la ressource ; lui repondre 404 en ecriture mentirait sur ce qu'il lit.
    if (match.rule.write && access.role !== 'owner') {
      throw new ForbiddenException(
        'Read-only access: this collection is shared with you',
      );
    }
    // C'est le premium du **proprietaire** qui est verifie, pas celui du requerant : sans
    // cela, un membre non premium ne pourrait pas lire ce qu'on lui partage.
    if (!(await this.premium.isPremium(access.ownerUserId))) {
      throw new PaymentRequiredException();
    }

    return {
      userId,
      collectionId,
      principalHeader: this.mint({
        userId,
        // Le premium transmis est celui du requerant pour ses propres decisions ; ce qui
        // conditionne l'acces a CETTE collection est deja tranche ci-dessus.
        premium: access.role === 'owner',
        role: access.role,
        statuses: access.statuses,
      }),
    };
  }

  /** Verifie le JWT emis par `identity`. C'est la seule verification de JWT de la chaine. */
  verifyJwt(req: Request): string {
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      throw new UnauthorizedException('Empty bearer token');
    }
    let decoded: jwt.JwtPayload | string;
    try {
      decoded = jwt.verify(token, this.jwtPublicKey, {
        algorithms: [JWT_ALGORITHM],
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    if (typeof decoded === 'string' || typeof decoded.sub !== 'string') {
      throw new UnauthorizedException('Invalid token payload');
    }
    return decoded.sub;
  }

  private mint(input: {
    userId: string;
    premium: boolean;
    role?: 'owner' | 'shared';
    statuses?: ShareStatus[];
  }): string {
    const principal: Principal = {
      userId: input.userId,
      premium: input.premium,
      ...(input.role ? { role: input.role } : {}),
      ...(input.statuses ? { statuses: input.statuses } : {}),
      exp: Math.floor(Date.now() / 1000) + this.ttlSeconds,
      origin: 'gateway',
    };
    return encodePrincipal(principal, this.secret);
  }
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Pose par le proxy apres consultation du registre de routage. */
    resolvedCollectionId?: string;
  }
}
