import {
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CollectionTypeCode } from '../common/internal/contracts';

/**
 * Les services que le gateway sait joindre. C'est la seule table de la constellation qui
 * associe un nom a une adresse : aucun service aval ne connait l'adresse d'un catalog, et
 * c'est ce qui empeche une dependance directe entre deux `apps/` de se former par accident.
 */
export type ServiceName =
  | 'identity'
  | 'billing'
  | 'connections'
  | 'sharing'
  | 'search'
  | 'catalog-generic'
  | 'catalog-manga'
  | 'catalog-vinyl';

/**
 * Quel catalog sert quel type de collection. `movie`, `book` et `game` partagent
 * `catalog-generic` : leurs profils de type ne different pas assez pour justifier trois
 * processus (2 de architecture-microservices.md).
 */
export const CATALOG_BY_TYPE: Record<CollectionTypeCode, ServiceName> = {
  manga: 'catalog-manga',
  vinyl: 'catalog-vinyl',
  movie: 'catalog-generic',
  book: 'catalog-generic',
  game: 'catalog-generic',
};

/** Les catalogs distincts, sans doublon : la cible d'un scatter-gather sans filtre de type. */
export const ALL_CATALOGS: ServiceName[] = [
  'catalog-manga',
  'catalog-vinyl',
  'catalog-generic',
];

const ENV_KEY: Record<ServiceName, string> = {
  identity: 'IDENTITY_BASE_URL',
  billing: 'BILLING_BASE_URL',
  connections: 'CONNECTIONS_BASE_URL',
  sharing: 'SHARING_BASE_URL',
  search: 'SEARCH_BASE_URL',
  'catalog-generic': 'CATALOG_GENERIC_BASE_URL',
  'catalog-manga': 'CATALOG_MANGA_BASE_URL',
  'catalog-vinyl': 'CATALOG_VINYL_BASE_URL',
};

@Injectable()
export class ServiceRegistryService implements OnModuleInit {
  private readonly logger = new Logger(ServiceRegistryService.name);
  private readonly urls = new Map<ServiceName, string>();

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    for (const [name, key] of Object.entries(ENV_KEY) as [
      ServiceName,
      string,
    ][]) {
      const url = this.config.get<string>(key);
      if (url) this.urls.set(name, url.replace(/\/+$/, ''));
    }
    const missing = (Object.keys(ENV_KEY) as ServiceName[]).filter(
      (n) => !this.urls.has(n),
    );
    this.logger.log(
      `services joignables : ${[...this.urls.keys()].join(', ') || '(aucun)'}`,
    );
    if (missing.length > 0) {
      // Un avertissement, pas une erreur : developper un seul service avec le reste
      // eteint est le mode de travail normal. Les routes concernees repondront 503.
      this.logger.warn(
        `services non configures (leurs routes repondront 503) : ${missing.join(', ')}`,
      );
    }
  }

  /** Adresse du service, ou `undefined` s'il n'est pas configure. */
  find(name: ServiceName): string | undefined {
    return this.urls.get(name);
  }

  /** Adresse du service, ou 503 - la reponse honnete quand on ne sait pas ou router. */
  require(name: ServiceName): string {
    const url = this.urls.get(name);
    if (!url) {
      throw new ServiceUnavailableException(`service '${name}' not configured`);
    }
    return url;
  }

  /** Catalogs effectivement configures, dans l'ordre stable de {@link ALL_CATALOGS}. */
  availableCatalogs(): ServiceName[] {
    return ALL_CATALOGS.filter((c) => this.urls.has(c));
  }

  catalogForType(typeCode: string): ServiceName {
    const target = CATALOG_BY_TYPE[typeCode as CollectionTypeCode];
    if (!target) {
      throw new ServiceUnavailableException(
        `no catalog serves collection type '${typeCode}'`,
      );
    }
    return target;
  }
}
