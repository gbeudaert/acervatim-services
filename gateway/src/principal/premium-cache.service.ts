import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis, { Redis } from 'ioredis';
import { InternalPremium } from '../common/internal/contracts';
import { InternalClientService } from '../common/internal/internal-client.service';
import { ServiceRegistryService } from '../routing/service-registry.service';

const KEY_PREFIX = 'gw:premium:';

/**
 * Statut premium sur le chemin chaud (3.6 de architecture-microservices.md).
 *
 * Le monolithe resolvait le premium **en base a chaque requete** - y compris celui du
 * proprietaire quand un membre lit une collection partagee. En micro-services ce serait un
 * aller-retour reseau par requete, sur toutes les routes du domaine collection. D'ou ce
 * cache, de TTL court et volontairement assume : pendant au plus `PREMIUM_CACHE_TTL`
 * secondes, une perte de premium n'est pas encore effective. C'est acceptable parce que la
 * perte de premium **suspend** les partages, elle ne detruit rien - la fenetre coute une
 * lecture de trop, jamais une donnee.
 *
 * Redis indisponible : on interroge `billing` directement. Le cache est une optimisation,
 * pas une dependance - le degrader en panne d'autorisation serait hors de proportion.
 */
@Injectable()
export class PremiumCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PremiumCacheService.name);
  private client?: Redis;
  private available = false;
  private ttlSeconds = 60;

  constructor(
    private readonly config: ConfigService,
    private readonly internal: InternalClientService,
    private readonly services: ServiceRegistryService,
  ) {}

  onModuleInit(): void {
    this.ttlSeconds = this.config.get<number>('PREMIUM_CACHE_TTL', 60);
    this.client = new IORedis({
      host: this.config.get<string>('REDIS_HOST', 'localhost'),
      port: this.config.get<number>('REDIS_PORT', 6379),
      // Echouer vite plutot que de mettre des commandes en file hors-ligne : ce cache est
      // sur le chemin de chaque requete, une commande en attente y devient une latence.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      retryStrategy: (times) => Math.min(times * 200, 3000),
    });
    this.client.on('ready', () => (this.available = true));
    this.client.on('close', () => (this.available = false));
    this.client.on('end', () => (this.available = false));
    // Sans listener 'error', un EventEmitter leve et fait tomber le processus.
    this.client.on('error', (err: Error) =>
      this.logger.debug(`redis premium cache: ${err.message}`),
    );
  }

  isRedisAvailable(): boolean {
    return this.available;
  }

  /**
   * Statut premium d'un utilisateur. `billing` injoignable -> `false`.
   *
   * Ce repli est le seul sur pour une decision d'autorisation : supposer `true` accorderait
   * un droit qu'on ne sait pas verifier. Sa consequence est franche - les routes premium
   * repondent 402 tant que `billing` est absent - et c'est preferable a une ouverture
   * silencieuse.
   */
  async isPremium(userId: string): Promise<boolean> {
    return (await this.status(userId)).premium;
  }

  async status(userId: string): Promise<InternalPremium> {
    const cached = await this.readCache(userId);
    if (cached) return cached;

    const baseUrl = this.services.find('billing');
    if (!baseUrl) {
      this.logger.warn('billing non configure - premium suppose absent');
      return { premium: false, source: 'none', expiresAt: null };
    }

    const fresh = await this.internal.tryRequest<InternalPremium>(
      baseUrl,
      `/internal/premium/${encodeURIComponent(userId)}`,
    );
    if (!fresh) {
      // Pas de mise en cache d'un echec : un `billing` qui redemarre doit reprendre effet
      // tout de suite, pas au bout du TTL.
      return { premium: false, source: 'none', expiresAt: null };
    }

    await this.writeCache(userId, fresh);
    return fresh;
  }

  /**
   * Invalide l'entree d'un utilisateur. Appelee apres une operation qui change son statut
   * (verification d'achat, consommation d'une invitation) pour que l'effet soit immediat
   * plutot que differe du TTL : c'est la moitie du compromis qui rend le TTL acceptable.
   */
  async invalidate(userId: string): Promise<void> {
    if (!this.available || !this.client) return;
    try {
      await this.client.del(KEY_PREFIX + userId);
    } catch (err) {
      this.logger.debug(`invalidation ignoree : ${(err as Error).message}`);
    }
  }

  private async readCache(userId: string): Promise<InternalPremium | null> {
    if (!this.available || !this.client || this.ttlSeconds === 0) return null;
    try {
      const raw = await this.client.get(KEY_PREFIX + userId);
      return raw ? (JSON.parse(raw) as InternalPremium) : null;
    } catch {
      return null;
    }
  }

  private async writeCache(
    userId: string,
    value: InternalPremium,
  ): Promise<void> {
    if (!this.available || !this.client || this.ttlSeconds === 0) return;
    try {
      await this.client.set(
        KEY_PREFIX + userId,
        JSON.stringify(value),
        'EX',
        this.ttlSeconds,
      );
    } catch (err) {
      this.logger.debug(`mise en cache ignoree : ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
