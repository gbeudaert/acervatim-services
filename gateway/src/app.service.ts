import { Injectable, Logger } from '@nestjs/common';
import { InternalClientService } from './common/internal/internal-client.service';
import { PremiumCacheService } from './principal/premium-cache.service';
import { PrismaService } from './prisma/prisma.service';
import {
  ServiceName,
  ServiceRegistryService,
} from './routing/service-registry.service';

export interface ServiceHealth {
  service: ServiceName;
  configured: boolean;
  reachable: boolean;
}

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
   * Un service aval injoignable ne rend **pas** le gateway `down` : ses routes repondront
   * 502 ou 503, les autres continuent de fonctionner. C'est le comportement recherche - le
   * decoupage n'a d'interet que si un adapter qui boucle ne fait pas tomber le reste (2).
   * Le detail par service est expose pour que la panne reste diagnosticable.
   */
  async ready(): Promise<{
    status: string;
    db: boolean;
    redis: boolean;
    registry: { collections: number; resources: number } | null;
    services: ServiceHealth[];
  }> {
    let db = true;
    let registry: { collections: number; resources: number } | null = null;
    try {
      const [collections, resources] = await Promise.all([
        this.prisma.collectionRegistry.count(),
        this.prisma.resourceRegistry.count(),
      ]);
      registry = { collections, resources };
    } catch {
      db = false;
    }

    const services = await this.probeServices();
    return {
      status: db ? 'ok' : 'degraded',
      db,
      redis: this.premium.isRedisAvailable(),
      registry,
      services,
    };
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
    ];
    return Promise.all(
      names.map(async (service) => {
        const baseUrl = this.services.find(service);
        if (!baseUrl) {
          return { service, configured: false, reachable: false };
        }
        const res = await this.internal.tryRequest<unknown>(
          baseUrl,
          '/health',
          { timeoutMs: 1_000 },
        );
        return { service, configured: true, reachable: res !== null };
      }),
    );
  }

  /**
   * Agregation OpenAPI (1 de architecture-microservices.md).
   *
   * Le contrat public est un seul document du point de vue de l'app : le decoupage ne doit
   * pas obliger a consulter huit specifications pour connaitre `/v1/*`. On fusionne les
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
