import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Request } from 'express';
import { RouteRule } from '../routing/route-table';

const WINDOW_MS = 60_000;
const DEFAULT_LIMIT_PER_MIN = 100;
/** Au-dela, les compartiments les plus anciens sont oublies (garde-fou memoire). */
const MAX_BUCKETS = 50_000;

interface Bucket {
  count: number;
  /** Fin de la fenetre courante, en epoch ms. */
  resetAt: number;
}

/**
 * Limitation de debit par route.
 *
 * Remplace `ThrottlerGuard` plutot que de s'y ajouter, pour une raison de forme : le
 * gateway sert toutes ses routes par un **controleur attrape-tout**, donc les decorateurs
 * `@Throttle` et `@SkipThrottle` - qui s'appliquent a un handler - n'ont plus de handler
 * distinct sur lequel se poser. Les resserrages du monolithe (auth 10/min, redeem 5/min)
 * et l'exemption du webhook RTDN sont donc declares dans `route-table.ts`, a cote du reste
 * de la regle de route, et appliques ici.
 *
 * Fenetre fixe en memoire du processus. **Suffisant tant que le gateway est unique** ; s'il
 * se replique, chaque replique compterait sa propre fenetre et le plafond effectif serait
 * multiplie par le nombre de repliques - il faudra alors passer les compteurs dans Redis,
 * qui est deja la pour le cache premium.
 */
@Injectable()
export class RouteThrottleService {
  private readonly logger = new Logger(RouteThrottleService.name);
  private readonly buckets = new Map<string, Bucket>();

  /** Leve `429` si le budget de la route est depasse pour ce client. */
  assertWithinLimit(req: Request, rule: RouteRule): void {
    if (process.env.NODE_ENV === 'test') return;

    const limit = rule.rateLimitPerMin ?? DEFAULT_LIMIT_PER_MIN;
    // `0` = exempte. Le webhook RTDN en depend : Pub/Sub retenterait en boucle sur un 429,
    // transformant un pic legitime en tempete de retentatives.
    if (limit === 0) return;

    // Compartiment par (client, route) et non par client seul : sinon une application qui
    // synchronise beaucoup consommerait le budget de son propre login.
    const key = `${clientKey(req)}|${rule.methods[0]} ${rule.pattern}`;
    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      this.evictIfNeeded();
      this.buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
      return;
    }

    bucket.count += 1;
    if (bucket.count > limit) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      throw new HttpException(
        `Too many requests, retry in ${retryAfter}s`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Purge les fenetres expirees quand la table grossit trop. Balayage paresseux plutot
   * qu'un intervalle : sans trafic il n'y a rien a nettoyer, et un timer qui tourne dans
   * le vide sur le processus le plus charge du systeme n'a pas sa place.
   */
  private evictIfNeeded(): void {
    if (this.buckets.size < MAX_BUCKETS) return;
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    if (this.buckets.size >= MAX_BUCKETS) {
      // Plus rien a expirer et toujours plein : on repart de zero plutot que de laisser
      // la memoire croitre sans borne. Un client perd au pire son compteur en cours.
      this.logger.warn(
        `throttle: ${this.buckets.size} compartiments actifs, reinitialisation`,
      );
      this.buckets.clear();
    }
  }
}

/**
 * Identifie le client. `req.ip` avec `trust proxy` a 1 : le gateway est derriere un seul
 * saut de proxy de confiance, donc l'adresse refletee est celle du client reel et non
 * celle du reverse proxy - sans quoi tous les utilisateurs partageraient un compartiment.
 */
function clientKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
