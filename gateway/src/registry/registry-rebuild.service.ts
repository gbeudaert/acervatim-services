import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InternalClientService } from '../common/internal/internal-client.service';
import { InternalRegistryEntriesPage } from '../common/internal/contracts';
import { PrismaService } from '../prisma/prisma.service';
import {
  ServiceName,
  ServiceRegistryService,
} from '../routing/service-registry.service';

const PAGE_SIZE = 500;

export interface RebuildReport {
  runId: string;
  scanned: number;
  added: number;
  removed: number;
  corrected: number;
  /** Catalogs qui n'ont pas repondu : leurs entrees ne sont ni corrigees ni purgees. */
  skipped: ServiceName[];
}

/**
 * Job de reparation du registre de routage (3.3 de architecture-microservices.md).
 *
 * **Exige des la mise en service du registre, pas apres.** Un registre divergent produit des
 * `404` sur des ressources qui existent : c'est le symptome le plus difficile a diagnostiquer
 * de toute la cible, parce qu'il ressemble a une suppression normale. Le registre etant
 * integralement reconstructible par re-scan, il n'y a aucune raison de vivre avec la
 * divergence - seulement une raison de la mesurer.
 *
 * Regle de surete : **un catalog qui ne repond pas n'entraine aucune suppression**. Sans
 * cela, un catalog momentanement indisponible ferait purger toutes ses collections du
 * registre, et le job de reparation deviendrait la panne qu'il devait corriger.
 */
@Injectable()
export class RegistryRebuildService {
  private readonly logger = new Logger(RegistryRebuildService.name);
  /** Verrou intra-processus. A remplacer par un verrou Redis si le gateway se replique. */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly internal: InternalClientService,
    private readonly services: ServiceRegistryService,
  ) {}

  /**
   * Nocturne. Le re-scan lit tout le catalogue de chaque service : le faire en journee
   * ajouterait une charge constante pour corriger un ecart qui, en regime nominal, est nul.
   */
  @Cron('0 30 3 * * *')
  async scheduled(): Promise<void> {
    try {
      const report = await this.rebuild();
      if (report.added || report.removed || report.corrected) {
        // Un ecart non nul en regime nominal signale une ecriture synchrone perdue :
        // c'est l'alerte, pas la reparation, qui compte ici.
        this.logger.warn(
          `registre divergent corrige : +${report.added} -${report.removed} ~${report.corrected} (sur ${report.scanned} entrees)`,
        );
      }
    } catch (err) {
      this.logger.error(
        `reconstruction du registre echouee : ${(err as Error).message}`,
      );
    }
  }

  async rebuild(): Promise<RebuildReport> {
    if (this.running) {
      throw new Error('une reconstruction est deja en cours');
    }
    this.running = true;
    const run = await this.prisma.registryRebuildRun.create({ data: {} });

    try {
      const catalogs = this.services.availableCatalogs();
      const skipped: ServiceName[] = [];
      const seenCollections = new Map<
        string,
        { userId: string; typeCode: string }
      >();
      const seenResources = new Map<
        string,
        { kind: string; collectionId: string }
      >();

      for (const catalog of catalogs) {
        const ok = await this.scanCatalog(
          catalog,
          seenCollections,
          seenResources,
        );
        if (!ok) skipped.push(catalog);
      }

      const scanned = seenCollections.size + seenResources.size;
      const { added, corrected } = await this.reconcileForward(
        seenCollections,
        seenResources,
      );
      // Aucune purge si un catalog manque a l'appel : ses lignes seraient vues comme
      // orphelines alors qu'elles sont seulement invisibles.
      const removed =
        skipped.length > 0
          ? 0
          : await this.purgeOrphans(seenCollections, seenResources);

      await this.prisma.registryRebuildRun.update({
        where: { id: run.id },
        data: {
          finishedAt: new Date(),
          state: skipped.length > 0 ? 'partial' : 'done',
          scanned,
          added,
          removed,
          corrected,
        },
      });

      return { runId: run.id, scanned, added, removed, corrected, skipped };
    } catch (err) {
      await this.prisma.registryRebuildRun.update({
        where: { id: run.id },
        data: {
          finishedAt: new Date(),
          state: 'failed',
          lastError: (err as Error).message.slice(0, 2000),
        },
      });
      throw err;
    } finally {
      this.running = false;
    }
  }

  /** `false` si le catalog n'a pas pu etre scanne entierement. */
  private async scanCatalog(
    catalog: ServiceName,
    collections: Map<string, { userId: string; typeCode: string }>,
    resources: Map<string, { kind: string; collectionId: string }>,
  ): Promise<boolean> {
    const baseUrl = this.services.find(catalog);
    if (!baseUrl) return false;

    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (cursor) query.set('cursor', cursor);
      const page: InternalRegistryEntriesPage | null =
        await this.internal.tryRequest<InternalRegistryEntriesPage>(
          baseUrl,
          `/internal/registry/entries?${query.toString()}`,
          // Un scan complet est long : le budget de 2 s des appels internes courants
          // ne s'applique pas ici.
          { timeoutMs: 30_000 },
        );
      if (!page) {
        this.logger.warn(`re-scan interrompu : ${catalog} injoignable`);
        return false;
      }
      for (const c of page.collections) {
        collections.set(c.collectionId, {
          userId: c.userId,
          typeCode: c.typeCode,
        });
      }
      for (const r of page.resources) {
        resources.set(r.resourceId, {
          kind: r.kind,
          collectionId: r.collectionId,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);

    return true;
  }

  /** Ajoute ce qui manque, corrige ce qui a derive. */
  private async reconcileForward(
    collections: Map<string, { userId: string; typeCode: string }>,
    resources: Map<string, { kind: string; collectionId: string }>,
  ): Promise<{ added: number; corrected: number }> {
    let added = 0;
    let corrected = 0;

    const existingCollections = await this.prisma.collectionRegistry.findMany();
    const byId = new Map(existingCollections.map((c) => [c.collectionId, c]));
    for (const [collectionId, truth] of collections) {
      const current = byId.get(collectionId);
      if (!current) {
        await this.prisma.collectionRegistry.create({
          data: { collectionId, ...truth },
        });
        added += 1;
      } else if (
        current.userId !== truth.userId ||
        current.typeCode !== truth.typeCode
      ) {
        await this.prisma.collectionRegistry.update({
          where: { collectionId },
          data: truth,
        });
        corrected += 1;
      }
    }

    const existingResources = await this.prisma.resourceRegistry.findMany();
    const byResourceId = new Map(existingResources.map((r) => [r.resourceId, r]));
    for (const [resourceId, truth] of resources) {
      const current = byResourceId.get(resourceId);
      if (!current) {
        await this.prisma.resourceRegistry.create({
          data: { resourceId, ...truth },
        });
        added += 1;
      } else if (
        current.kind !== truth.kind ||
        current.collectionId !== truth.collectionId
      ) {
        await this.prisma.resourceRegistry.update({
          where: { resourceId },
          data: truth,
        });
        corrected += 1;
      }
    }

    return { added, corrected };
  }

  /** Retire du registre ce qu'aucun catalog ne revendique plus. */
  private async purgeOrphans(
    collections: Map<string, unknown>,
    resources: Map<string, unknown>,
  ): Promise<number> {
    const staleCollections = await this.prisma.collectionRegistry.findMany({
      select: { collectionId: true },
    });
    const toDropCollections = staleCollections
      .map((c) => c.collectionId)
      .filter((id) => !collections.has(id));

    const staleResources = await this.prisma.resourceRegistry.findMany({
      select: { resourceId: true },
    });
    const toDropResources = staleResources
      .map((r) => r.resourceId)
      .filter((id) => !resources.has(id));

    const [c, r] = await this.prisma.$transaction([
      this.prisma.collectionRegistry.deleteMany({
        where: { collectionId: { in: toDropCollections } },
      }),
      this.prisma.resourceRegistry.deleteMany({
        where: { resourceId: { in: toDropResources } },
      }),
    ]);
    return c.count + r.count;
  }

  /** Dernieres reconstructions - la mesure exigee au 4 avant tout passage de palier. */
  async recentRuns(limit = 5) {
    return this.prisma.registryRebuildRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
  }
}
