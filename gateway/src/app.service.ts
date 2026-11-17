import { Injectable, Logger } from '@nestjs/common';
import {
  READINESS_TIMEOUT_MS,
  ReadinessStatus,
  readinessStatus,
  withDeadline,
} from './common/health/readiness';
import {
  InternalCallError,
  InternalClientService,
} from './common/internal/internal-client.service';
import { PremiumCacheService } from './principal/premium-cache.service';
import { PrismaService } from './prisma/prisma.service';
import {
  ServiceName,
  ServiceRegistryService,
} from './routing/service-registry.service';

export interface ServiceHealth {
  service: ServiceName;
  configured: boolean;
  /** Le service a repondu, quel que soit le code. */
  reachable: boolean;
  /** Sa propre sonde de disponibilite a repondu `200`. */
  ready: boolean;
}

/**
 * Delai accorde a la sonde de disponibilite d'un service aval. Superieur a celui que ce
 * service accorde lui-meme a sa base : un voisin dont la base se tait a le temps de repondre
 * son `503`, et `reachable: false` signifie alors vraiment que son processus ne repond pas.
 */
const DOWNSTREAM_READY_TIMEOUT_MS = READINESS_TIMEOUT_MS + 1_000;

/**
 * Fragment OpenAPI tel qu'un service le publie. On ne modelise que ce qu'on fusionne :
 * un document complet porte bien d'autres cles, mais les reprendre toutes ferait du
 * gateway le proprietaire d'un schema qu'il n'ecrit pas.
 */
export interface OpenApiDocument {
  paths?: Record<string, unknown>;
  components?: { schemas?: Record<string, unknown> };
}

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly services: ServiceRegistryService,
    private readonly internal: InternalClientService,
    private readonly premium: PremiumCacheService,
  ) {}

  /** Liveness : le processus repond. Aucune dependance sollicitee. */
  health(): { status: string; service: string } {
    return { status: 'ok', service: 'acervatim-gateway' };
  }

  /**
   * Readiness du gateway ET de la constellation.
   *
   * La base du gateway (registre de routage) est vitale : injoignable ou muette au-dela du
   * delai, `unavailable`, que le controleur traduit en `503`.
   *
   * Un service aval qui n'est pas pret ne rend **pas** le gateway indisponible : ses routes
   * repondront 502 ou 503, les autres continuent de fonctionner. C'est le comportement
   * recherche - le decoupage n'a d'interet que si un adapter qui boucle ne fait pas tomber
   * le reste (2). Il rend en revanche le statut `degraded`, et le detail par service est
   * expose pour que la panne reste diagnosticable. Redis de meme : sans lui, le premium est
   * lu chez `billing` a chaque requete, plus lentement mais exactement.
   *
   * Chaque service aval est interroge sur **sa** sonde de disponibilite, pas sur sa sonde de
   * vie : un service dont la base est perdue repond encore `/health`, et c'est cet appel que
   * la procedure de bascule consulte pour savoir si la constellation est complete.
   */
  async ready(): Promise<{
    status: ReadinessStatus;
    db: boolean;
    redis: boolean;
    registry: { collections: number; resources: number } | null;
    services: ServiceHealth[];
  }> {
    // En parallele : la duree de la sonde est bornee par le plus long des deux delais, pas
    // par leur somme.
    const [registry, services] = await Promise.all([
      this.readRegistry(),
      this.probeServices(),
    ]);
    const db = registry !== null;
    const redis = this.premium.isRedisAvailable();
    return {
      status: readinessStatus(db, redis && services.every((s) => s.ready)),
      db,
      redis,
      registry,
      services,
    };
  }

  /** Compteurs du registre, ou `null` si la base n'a pas repondu dans le delai. */
  private async readRegistry(): Promise<{
    collections: number;
    resources: number;
  } | null> {
    try {
      const [collections, resources] = await withDeadline(
        Promise.all([
          this.prisma.collectionRegistry.count(),
          this.prisma.resourceRegistry.count(),
        ]),
      );
      return { collections, resources };
    } catch {
      return null;
    }
  }

  private async probeServices(): Promise<ServiceHealth[]> {
    const names: ServiceName[] = [
      'identity',
      'billing',
      'connections',
      'sharing',
      'search',
      'catalog-generic',
      'catalog-manga',
      'catalog-vinyl',
      'catalog-lego',
    ];
    return Promise.all(
      names.map(async (service): Promise<ServiceHealth> => {
        const baseUrl = this.services.find(service);
        if (!baseUrl) {
          return { service, configured: false, reachable: false, ready: false };
        }
        try {
          await this.internal.request<unknown>(baseUrl, '/health/ready', {
            timeoutMs: DOWNSTREAM_READY_TIMEOUT_MS,
          });
          return { service, configured: true, reachable: true, ready: true };
        } catch (err) {
          // Un code HTTP prouve que le voisin repond : il n'est simplement pas pret.
          const reachable = err instanceof InternalCallError;
          return { service, configured: true, reachable, ready: false };
        }
      }),
    );
  }

  /**
   * Agregation OpenAPI (1 de architecture-microservices.md).
   *
   * Le contrat public est un seul document du point de vue de l'app : le decoupage ne doit
   * pas obliger a consulter neuf specifications pour connaitre `/v1/*`. On fusionne les
   * `paths` de chaque service ; en cas de collision - deux services declarant le meme
   * chemin - on garde le premier et on **journalise**, parce qu'une collision signale une
   * table de routage et une implementation qui ne disent pas la meme chose.
   */
  async aggregateOpenApi(base: OpenApiDocument): Promise<OpenApiDocument> {
    const paths: Record<string, unknown> = { ...(base.paths ?? {}) };
    const schemas: Record<string, unknown> = {
      ...(base.components?.schemas ?? {}),
    };

    const names: ServiceName[] = [
      'identity',
      'billing',
      'connections',
      'sharing',
      'search',
      'catalog-generic',
      'catalog-manga',
      'catalog-vinyl',
      'catalog-lego',
    ];

    for (const service of names) {
      const baseUrl = this.services.find(service);
      if (!baseUrl) continue;
      const doc = await this.internal.tryRequest<OpenApiDocument>(
        baseUrl,
        '/openapi.json',
        { timeoutMs: 5_000 },
      );
      if (!doc) continue;

      for (const [path, item] of Object.entries(doc.paths ?? {})) {
        if (paths[path] !== undefined) {
          this.logger.warn(
            `OpenAPI: chemin ${path} declare par plusieurs services - premier conserve`,
          );
          continue;
        }
        paths[path] = item;
      }
      for (const [name, schema] of Object.entries(
        doc.components?.schemas ?? {},
      )) {
        if (schemas[name] === undefined) schemas[name] = schema;
      }
    }

    return {
      ...base,
      paths,
      components: { ...(base.components ?? {}), schemas },
    };
  }
}
