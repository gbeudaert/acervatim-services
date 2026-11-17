import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import jwt from 'jsonwebtoken';
import { decodePrincipal, PrincipalDecodeError } from './principal.codec';
import { Principal, PRINCIPAL_HEADER } from './principal.types';

const JWT_ALGORITHM = 'RS256';

/**
 * Porte d'entree unique du service, avec deux modes assumes :
 *
 * 1. **Derriere le gateway** (cible) - l'en-tete `X-Acervatim-Principal` porte une identite
 *    deja resolue et signee ; on verifie la signature et on s'arrete la. Aucun aller-retour
 *    reseau sur le chemin chaud, c'est tout l'objet du 3.6 de l'architecture.
 * 2. **Autonome** (aujourd'hui) - pas de gateway : on verifie le JWT emis par `identity`
 *    avec la cle publique. Le premium n'est alors pas resoluble depuis ce service, donc
 *    `premium: false` : les sources a jeton retombent sur le mode degrade au lieu de
 *    supposer un droit qu'on ne peut pas verifier.
 *
 * Regle de securite : quand `INTERNAL_PRINCIPAL_SECRET` est configure, un en-tete principal
 * present et invalide est un **rejet**, jamais un repli silencieux sur le JWT - sinon
 * n'importe quel client pourrait forcer le chemin JWT en envoyant un principal bidon.
 */
@Injectable()
export class PrincipalGuard implements CanActivate, OnModuleInit {
  private readonly logger = new Logger(PrincipalGuard.name);
  private principalSecret?: string;
  private jwtPublicKey!: string;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.principalSecret = this.config.get<string>('INTERNAL_PRINCIPAL_SECRET');
    // Meme convention que le monolithe : la cle est stockee sur une ligne, newlines
    // echappees. Sans ce desechappement, `jwt.verify` refuse un PEM pourtant valide.
    this.jwtPublicKey = this.config
      .get<string>('JWT_PUBLIC_KEY')!
      .split('\\n')
      .join('\n');
    this.logger.log(
      this.principalSecret
        ? 'principal signe actif (mode gateway) - le JWT reste accepte en repli'
        : 'aucun INTERNAL_PRINCIPAL_SECRET - mode autonome, JWT uniquement',
    );
  }

  canActivate(ctx: ExecutionContext): boolean {
    this.resolve(ctx.switchToHttp().getRequest<Request>());
    return true;
  }

  /**
   * Etablit l'identite et la pose sur la requete. Expose separement de `canActivate` parce
   * que les catalogs doivent l'appliquer par **middleware** : leurs controleurs de domaine
   * viennent de `@acervatim/catalog-core`, ou l'on ne peut pas poser de `@UseGuards`. Une
   * seule implementation, deux points d'accroche.
   */
  resolve(req: Request): Principal {
    const principal =
      this.fromPrincipalHeader(req) ?? this.fromBearerToken(req);
    req.principal = principal;
    req.userId = principal.userId;
    return principal;
  }

  private fromPrincipalHeader(req: Request): Principal | undefined {
    const raw = req.headers[PRINCIPAL_HEADER];
    if (typeof raw !== 'string' || !this.principalSecret) return undefined;
    try {
      return decodePrincipal(raw, this.principalSecret);
    } catch (err) {
      if (err instanceof PrincipalDecodeError) {
        throw new UnauthorizedException(`Invalid principal: ${err.message}`);
      }
      throw err;
    }
  }

  private fromBearerToken(req: Request): Principal {
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
    return {
      userId: decoded.sub,
      premium: false,
      exp: decoded.exp ?? Math.floor(Date.now() / 1000) + 60,
      origin: 'jwt',
    };
  }
}
