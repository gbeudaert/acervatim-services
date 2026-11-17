import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CatalogService } from '../catalog/catalog.service';
import { ApiCacheService } from '../common/cache/api-cache.service';
import {
  InternalLegoBarcodeLookup,
  LegoBarcodeLookup,
} from '../common/internal/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { barcodeVariants } from './barcode';
import { bricksetPatch, bricksetSetNum, carriesCode } from './brickset-match';
import {
  BricksetBudgetExhaustedError,
  BricksetNotConfiguredError,
  BricksetService,
} from './brickset.service';
import { BricksetSet } from './brickset.types';

/** Une recherche par code ne rend qu'une poignee de fiches ; l'appel compte pareil a 20 ou 500. */
const LOOKUP_PAGE_SIZE = 20;
const DAY_MS = 24 * 3600 * 1000;

/** Issue d'un appel a Brickset, partagee par tous les scans du meme code. */
type RemoteOutcome = Extract<
  LegoBarcodeLookup,
  'brickset' | 'miss' | 'disabled' | 'exhausted' | 'unavailable'
>;

/**
 * Recherche d'un code scanne (decision du 2026-11-16 : Brickset au scan, et non plus en
 * moissonnage).
 *
 * 1. un set des CSV porte ce code, confirme depuis moins de `BRICKSET_BARCODE_TTL_DAYS` : il est
 *    servi, sans appel (`cache`) ;
 * 2. le code est marque inconnu depuis moins de `BRICKSET_MISS_TTL_DAYS` : liste vide (`miss`) ;
 * 3. sinon, **un** appel `getSets` cherche le code, par la file et dans la limite du budget du
 *    jour. Seules les fiches qui portent ce code et dont le set existe dans les CSV sont
 *    annotees (`ean`, `upc`, `brickset_id`, date) ; aucun set n'est cree. Rien d'annote : le code
 *    est marque inconnu.
 *
 * Deux scans simultanes du meme code partagent le meme appel. Le scan n'attend Brickset que
 * `BRICKSET_SCAN_WAIT_MS` : au-dela il rend `pending`, l'appel continue, et son resultat sert le
 * scan suivant. Une erreur de Brickset ne marque jamais un code inconnu.
 */
@Injectable()
export class BricksetLookupService implements OnModuleInit {
  private readonly logger = new Logger(BricksetLookupService.name);
  private barcodeTtlDays!: number;
  private missTtlDays!: number;
  private scanWaitMs!: number;
  /** Appels en cours, par forme canonique du code. Un seul exemplaire du service tourne. */
  private readonly inflight = new Map<string, Promise<RemoteOutcome>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly brickset: BricksetService,
    private readonly cache: ApiCacheService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.barcodeTtlDays = this.config.get<number>(
      'BRICKSET_BARCODE_TTL_DAYS',
      90,
    );
    this.missTtlDays = this.config.get<number>('BRICKSET_MISS_TTL_DAYS', 7);
    this.scanWaitMs = this.config.get<number>('BRICKSET_SCAN_WAIT_MS', 6000);
  }

  /** Plus ancienne date de confirmation encore servie. */
  freshSince(now: Date = new Date()): Date {
    return new Date(now.getTime() - this.barcodeTtlDays * DAY_MS);
  }

  async lookup(code: string): Promise<InternalLegoBarcodeLookup> {
    const variants = barcodeVariants(code);
    if (variants.length === 0) return { items: [], lookup: 'miss' };

    const cached = await this.catalog.findByBarcode(code, this.freshSince());
    if (cached.length > 0) return { items: cached, lookup: 'cache' };

    const key = canonicalCode(variants);
    if (await this.cache.get(missKey(key))) {
      return { items: [], lookup: 'miss' };
    }
    if (!this.brickset.isConfigured()) {
      return { items: [], lookup: 'disabled' };
    }

    const outcome = await withinDeadline(
      this.remote(key, variants),
      this.scanWaitMs,
    );
    if (outcome === null) return { items: [], lookup: 'pending' };
    if (outcome !== 'brickset') return { items: [], lookup: outcome };
    return {
      items: await this.catalog.findByBarcode(code, this.freshSince()),
      lookup: 'brickset',
    };
  }

  /** L'appel en cours pour ce code, ou un nouveau. */
  private remote(key: string, variants: string[]): Promise<RemoteOutcome> {
    const running = this.inflight.get(key);
    if (running) return running;
    const call = this.fetchAndAnnotate(key, variants).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, call);
    return call;
  }

  /** Ne leve jamais : l'appel peut finir apres la reponse au scan, personne ne l'attend plus. */
  private async fetchAndAnnotate(
    key: string,
    variants: string[],
  ): Promise<RemoteOutcome> {
    let sets: BricksetSet[];
    try {
      const res = await this.brickset.getSets({
        query: key,
        pageNumber: 1,
        pageSize: LOOKUP_PAGE_SIZE,
      });
      sets = res.sets ?? [];
    } catch (err) {
      if (err instanceof BricksetBudgetExhaustedError) return 'exhausted';
      if (err instanceof BricksetNotConfiguredError) return 'disabled';
      this.logger.warn(`brickset: recherche de ${key} - ${errorMessage(err)}`);
      return 'unavailable';
    }

    try {
      const annotated = await this.annotate(
        sets.filter((s) => carriesCode(s, variants)),
      );
      if (annotated > 0) return 'brickset';
      await this.cache.set(
        missKey(key),
        { checkedAt: new Date().toISOString() },
        this.missTtlDays * 24 * 3600,
      );
      return 'miss';
    } catch (err) {
      this.logger.error(`brickset: ecriture de ${key} - ${errorMessage(err)}`);
      return 'unavailable';
    }
  }

  /**
   * Annote les sets des CSV qui portent le code, et rend leur nombre. La date avance meme quand
   * les codes n'ont pas change : c'est elle qui fait courir les 90 jours.
   *
   * Un meme set peut revenir deux fois (variante `0` ramenee a `1`) : l'etat connu est mis a jour
   * apres chaque ecriture, pour que la seconde fiche soit comparee a la premiere.
   */
  private async annotate(sets: BricksetSet[]): Promise<number> {
    const keyed = sets
      .map((s) => ({ s, setNum: bricksetSetNum(s) }))
      .filter((k): k is { s: BricksetSet; setNum: string } => k.setNum !== null);
    if (keyed.length === 0) return 0;

    const known = await this.prisma.legoSet.findMany({
      where: { setNum: { in: keyed.map((k) => k.setNum) } },
      select: { setNum: true, ean: true, upc: true, bricksetId: true },
    });
    // La collation de la base est insensible a la casse ; la carte doit l'etre aussi.
    const byNum = new Map(known.map((k) => [k.setNum.toLowerCase(), k]));

    const checkedAt = new Date();
    const annotated = new Set<string>();
    for (const { s, setNum } of keyed) {
      const current = byNum.get(setNum.toLowerCase());
      if (!current) continue;
      const patch = bricksetPatch(s, current) ?? {};
      await this.prisma.legoSet.update({
        where: { setNum: current.setNum },
        data: { ...patch, barcodeCheckedAt: checkedAt },
      });
      Object.assign(current, patch);
      annotated.add(current.setNum);
    }
    return annotated.size;
  }
}

/**
 * Forme sous laquelle un code est cherche chez Brickset et marque inconnu : la plus courte de
 * ses variantes. Un EAN-13 a zero de tete est un UPC-A, et c'est sous ses 12 chiffres que
 * Brickset le publie.
 */
export function canonicalCode(variants: string[]): string {
  return variants.reduce((a, b) => (b.length < a.length ? b : a));
}

export function missKey(code: string): string {
  return `brickset:miss:${code}`;
}

/** `promise`, ou `null` si elle n'est pas tenue dans le delai. Elle continue dans tous les cas. */
async function withinDeadline<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
