import { Inject, Injectable, Logger } from '@nestjs/common';
import { CollectionTypeCode } from '../contracts';

/**
 * Transport minimal des appels `/internal/*` sortants.
 *
 * `catalog-core` ne peut pas importer `InternalClientService` du socle : il est defini dans le
 * `src/` de chaque service, et la bibliotheque doit rester ignorante de l'arborescence de son
 * consommateur. Le service catalog fournit donc une implementation via ce jeton - la sienne,
 * celle du socle.
 */
export const INTERNAL_TRANSPORT = Symbol('INTERNAL_TRANSPORT');

export interface InternalTransport {
  request<T>(
    baseUrl: string,
    path: string,
    opts?: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown },
  ): Promise<T>;
  tryRequest<T>(
    baseUrl: string,
    path: string,
    opts?: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown },
  ): Promise<T | null>;
}

/** Configuration injectee par le service catalog (URLs des voisins). */
export const CATALOG_CONFIG = Symbol('CATALOG_CONFIG');

export interface CatalogConfig {
  /** Adresse du gateway, pour le registre de routage. Absente = pas d'enregistrement. */
  gatewayBaseUrl?: string;
  /** Adresse de `search`, pour le snapshot de source. Absente = pas de pre-remplissage. */
  searchBaseUrl?: string;
}

/**
 * Ecriture dans le registre de routage du gateway (3.3 de architecture-microservices.md).
 *
 * **En synchrone, a la creation et a la suppression.** Sans cette ecriture,
 * `GET /v1/items/:id` - dont l'URL ne porte pas le type de collection - n'est pas routable, et
 * la ressource repond `404` alors qu'elle existe.
 *
 * ### Pourquoi un echec d'enregistrement ne fait pas echouer la creation
 *
 * Le choix inverse - annuler la creation si le gateway ne repond pas - rendrait tout le
 * domaine collection indisponible des que le gateway hoquette, alors que la donnee, elle,
 * s'ecrit tres bien. On journalise donc en `error`, et le job de reparation nocturne du
 * gateway rattrape l'entree manquante par re-scan.
 *
 * C'est exactement le scenario que ce job existe pour couvrir, et la raison pour laquelle
 * l'architecture le veut des la mise en service du registre plutot qu'apres.
 */
@Injectable()
export class RegistryClientService {
  private readonly logger = new Logger(RegistryClientService.name);

  constructor(
    @Inject(INTERNAL_TRANSPORT) private readonly internal: InternalTransport,
    @Inject(CATALOG_CONFIG) private readonly config: CatalogConfig,
  ) {}

  /** Enregistre une collection. Idempotent cote gateway. */
  async registerCollection(
    collectionId: string,
    userId: string,
    typeCode: CollectionTypeCode,
  ): Promise<void> {
    await this.put(
      { collections: [{ collectionId, userId, typeCode }] },
      `collection ${collectionId}`,
    );
  }

  /** Enregistre des ressources (items, noeuds) en un seul appel. */
  async registerResources(
    resources: Array<{
      resourceId: string;
      kind: 'item' | 'node';
      collectionId: string;
    }>,
  ): Promise<void> {
    if (resources.length === 0) return;
    await this.put({ resources }, `${resources.length} ressource(s)`);
  }

  /**
   * Retire une entree. Supprimer une collection purge aussi ses ressources cote gateway :
   * la cascade SQL n'existe pas la-bas, la FK non plus.
   */
  async unregister(id: string): Promise<void> {
    const baseUrl = this.config.gatewayBaseUrl;
    if (!baseUrl) return;
    const res = await this.internal.tryRequest<unknown>(
      baseUrl,
      `/internal/registry/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    if (res === null) {
      // Une entree orpheline route vers ce catalog, qui repond 404 - le comportement correct
      // pour une ressource supprimee. Le passage nocturne la retirera.
      this.logger.error(
        `registre: desenregistrement de ${id} non confirme - entree orpheline jusqu'au re-scan`,
      );
    }
  }

  private async put(
    payload: Record<string, unknown>,
    label: string,
  ): Promise<void> {
    const baseUrl = this.config.gatewayBaseUrl;
    if (!baseUrl) {
      // Mode autonome (pas de gateway) : rien a enregistrer, personne ne route.
      return;
    }
    const res = await this.internal.tryRequest<unknown>(
      baseUrl,
      '/internal/registry',
      { method: 'PUT', body: payload },
    );
    if (res === null) {
      this.logger.error(
        `registre: enregistrement de ${label} non confirme - la ressource sera introuvable jusqu'au re-scan nocturne`,
      );
    }
  }
}
