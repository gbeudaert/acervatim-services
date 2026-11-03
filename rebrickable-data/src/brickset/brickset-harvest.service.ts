import { Injectable, Logger } from '@nestjs/common';
import { ImportRun } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeBarcode } from './barcode';
import {
  BricksetBudgetExhaustedError,
  BricksetService,
} from './brickset.service';
import { BricksetSet } from './brickset.types';

export const BRICKSET_SOURCE = 'brickset';
/** Maximum autorise par `getSets` : ~45 appels pour la totalite du catalogue. */
const PAGE_SIZE = 500;
/** Etats d'une campagne non close, donc reprenable. */
const OPEN_STATES = ['running', 'paused', 'failed'];
/** Un code-barres plausible : EAN-8 / UPC-E au plus court, EAN-14 au plus long. */
const MIN_CODE_LENGTH = 8;
const MAX_CODE_LENGTH = 14;

export type HarvestState = 'done' | 'paused' | 'failed' | 'skipped';

export interface HarvestReport {
  runId: string | null;
  mode: string;
  state: HarvestState;
  /** Premiere page demandee par ce run (reprise : derniere page consommee, relue). */
  fromPage: number;
  /** Derniere page consommee, `0` si aucune. */
  lastPage: number;
  callsUsed: number;
  rowsUpserted: number;
  unmatched: number;
  stoppedBy?: string;
}

/** Les colonnes que le moissonnage a le droit d'ecrire - et aucune autre. */
export interface BricksetPatch {
  ean?: string;
  upc?: string;
  bricksetId?: number;
}

/**
 * Campagne Brickset : les codes-barres EAN/UPC des sets, sous budget journalier, reprenable page
 * a page. La reprise **relit la derniere page consommee** : si le catalogue a bouge entre-temps
 * (un set insere avant la position), une reprise a la page suivante sauterait les sets passes
 * d'une page a l'autre. Une page de recouvrement coute un appel ; un trou ne se rattrape jamais.
 *
 * Trois regles, qui font la difference avec le moissonneur de `catalog-lego` :
 *  - **mise a jour seule** : un set inconnu de Rebrickable n'est jamais cree, il est compte dans
 *    `unmatched`. Le catalogue est celui des CSV ; Brickset ne fait que l'annoter ;
 *  - **un code connu n'est jamais efface** par une valeur vide ;
 *  - le filigrane de la campagne incrementale est lu sur le **dernier `done`, tout mode
 *    confondu** (il l'etait sur le dernier `full`, si bien que l'incremental redemandait tout
 *    depuis la premiere campagne), et un run repris est clos en `superseded` (les runs en pause
 *    ou en echec restaient ouverts indefiniment).
 *
 * Jamais declenchee par une recherche : seulement par le passage quotidien (`DailyRefreshService`)
 * et par `POST /admin/harvest/brickset`.
 */
@Injectable()
export class BricksetHarvestService {
  private readonly logger = new Logger(BricksetHarvestService.name);
  /** Single-flight intra-processus : une seule campagne a la fois dans ce service. */
  private inflight: Promise<HarvestReport> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly brickset: BricksetService,
  ) {}

  run(): Promise<HarvestReport> {
    if (this.inflight) {
      this.logger.warn('brickset: campagne deja en cours, rattache a celle-ci');
      return this.inflight;
    }
    this.inflight = this.campaign().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async campaign(): Promise<HarvestReport> {
    if (!this.brickset.isConfigured()) {
      this.logger.warn(
        'brickset: BRICKSET_API_KEY absent, aucun code-barres ne sera moissonne',
      );
      return {
        runId: null,
        mode: 'none',
        state: 'skipped',
        fromPage: 0,
        lastPage: 0,
        callsUsed: 0,
        rowsUpserted: 0,
        unmatched: 0,
        stoppedBy: 'not-configured',
      };
    }

    const lastDone = await this.prisma.importRun.findFirst({
      where: { source: BRICKSET_SOURCE, state: 'done' },
      orderBy: { finishedAt: 'desc' },
    });
    const open = await this.prisma.importRun.findFirst({
      where: { source: BRICKSET_SOURCE, state: { in: OPEN_STATES } },
      orderBy: { startedAt: 'desc' },
    });
    // Un run ouvert anterieur au dernier `done` appartient a une campagne deja terminee.
    const resumed =
      open && (!lastDone || open.startedAt > lastDone.startedAt) ? open : null;

    // Le premier passage complet fait l'index ; ensuite on ne demande que ce qui a bouge.
    const mode = resumed?.mode ?? (lastDone ? 'incremental' : 'full');
    const updatedSince =
      mode === 'incremental' && lastDone?.watermark
        ? lastDone.watermark.toISOString().slice(0, 10)
        : undefined;
    // Borne haute figee AVANT le premier appel, et conservee a la reprise : tout set modifie
    // pendant la campagne sera repris par la suivante. L'heure de fin creerait une fenetre
    // aveugle.
    const watermark = resumed?.watermark ?? new Date();
    const resumeFrom = resumed?.lastPage ?? 0;
    // Recouvrement d'une page : la derniere page consommee est relue (cf. en-tete de classe).
    const firstPage = Math.max(1, resumeFrom);

    const [, run] = await this.prisma.$transaction([
      this.prisma.importRun.updateMany({
        where: { source: BRICKSET_SOURCE, state: { in: OPEN_STATES } },
        data: { state: 'superseded', finishedAt: new Date() },
      }),
      this.prisma.importRun.create({
        data: {
          source: BRICKSET_SOURCE,
          mode,
          state: 'running',
          lastPage: resumeFrom,
          watermark,
        },
      }),
    ]);
    if (resumed) {
      this.logger.log(
        `brickset: reprise de ${resumed.id} (${mode}) page ${firstPage}`,
      );
    }

    const counters = { lastPage: resumeFrom, calls: 0, rows: 0, unmatched: 0 };
    const report = (
      state: HarvestState,
      stoppedBy?: string,
    ): HarvestReport => ({
      runId: run.id,
      mode,
      state,
      fromPage: firstPage,
      lastPage: counters.lastPage,
      callsUsed: counters.calls,
      rowsUpserted: counters.rows,
      unmatched: counters.unmatched,
      ...(stoppedBy ? { stoppedBy } : {}),
    });

    try {
      for (let page = firstPage; ; page++) {
        const res = await this.brickset.getSets({
          pageNumber: page,
          pageSize: PAGE_SIZE,
          updatedSince,
          orderBy: 'Number',
        });
        counters.calls++;
        const sets = res.sets ?? [];
        const applied = await this.applyPage(sets);
        counters.lastPage = page;
        counters.rows += applied.updated;
        counters.unmatched += applied.unmatched;
        await this.checkpoint(run, counters);

        const exhausted =
          sets.length < PAGE_SIZE ||
          (typeof res.matches === 'number' && page * PAGE_SIZE >= res.matches);
        if (exhausted) {
          await this.finishRun(run.id, 'done');
          return report('done');
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof BricksetBudgetExhaustedError) {
        // Arret nominal : la campagne suivante reprendra en relisant la derniere page lue.
        await this.finishRun(run.id, 'paused', message);
        this.logger.log(
          `${message} - reprise page ${Math.max(1, counters.lastPage)}`,
        );
        return report('paused', 'daily-budget');
      }
      await this.finishRun(run.id, 'failed', message);
      this.logger.error(`brickset: campagne echouee - ${message}`);
      return report('failed', message);
    }
  }

  /**
   * Annote les sets d'une page. Une seule lecture pour la page, puis une ecriture par set dont un
   * code change reellement.
   *
   * Un meme `setNum` peut revenir deux fois dans une page (variante `0` ramenee a `1`) : l'etat
   * connu est mis a jour apres chaque ecriture, pour que la seconde fiche soit comparee a ce qui
   * vient d'etre ecrit, et `updated` compte des sets distincts.
   */
  async applyPage(
    sets: BricksetSet[],
  ): Promise<{ updated: number; unmatched: number }> {
    const keyed = sets.map((s) => ({ s, setNum: bricksetSetNum(s) }));
    const setNums = keyed
      .map((k) => k.setNum)
      .filter((n): n is string => n !== null);
    const known =
      setNums.length === 0
        ? []
        : await this.prisma.legoSet.findMany({
            where: { setNum: { in: setNums } },
            select: { setNum: true, ean: true, upc: true, bricksetId: true },
          });
    // La collation de la base est insensible a la casse ; la carte doit l'etre aussi.
    const byNum = new Map(known.map((k) => [k.setNum.toLowerCase(), k]));

    const updated = new Set<string>();
    let unmatched = 0;
    for (const { s, setNum } of keyed) {
      const current = setNum ? byNum.get(setNum.toLowerCase()) : undefined;
      if (!current) {
        unmatched++;
        continue;
      }
      const data = bricksetPatch(s, current);
      if (!data) continue;
      await this.prisma.legoSet.update({
        where: { setNum: current.setNum },
        data,
      });
      Object.assign(current, data);
      updated.add(current.setNum);
    }
    return { updated: updated.size, unmatched };
  }

  async lastRuns(limit = 10): Promise<ImportRun[]> {
    return this.prisma.importRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
  }

  private async checkpoint(
    run: ImportRun,
    counters: {
      lastPage: number;
      calls: number;
      rows: number;
      unmatched: number;
    },
  ): Promise<void> {
    await this.prisma.importRun.update({
      where: { id: run.id },
      data: {
        lastPage: counters.lastPage,
        callsUsed: counters.calls,
        rowsUpserted: counters.rows,
        unmatched: counters.unmatched,
      },
    });
  }

  private async finishRun(
    id: string,
    state: HarvestState,
    lastError?: string,
  ): Promise<void> {
    await this.prisma.importRun.update({
      where: { id },
      data: {
        state,
        finishedAt: new Date(),
        ...(lastError ? { lastError } : {}),
      },
    });
  }
}

/** "42131" + variante 1 -> "42131-1", la forme canonique cote Rebrickable. */
export function bricksetSetNum(s: BricksetSet): string | null {
  if (!s.number) return null;
  const variant = s.numberVariant && s.numberVariant > 0 ? s.numberVariant : 1;
  return `${s.number}-${variant}`;
}

/**
 * Ce que Brickset apporte a un set connu, ou `null` s'il n'apporte rien.
 *
 * Un code vide (ou implausible) est **ignore**, jamais ecrit : il effacerait un code connu. Une
 * fiche sans aucun code n'ecrit rien du tout, pas meme `bricksetId` - sinon `contributedBy`
 * annoncerait une contribution qui n'existe pas.
 */
export function bricksetPatch(
  s: BricksetSet,
  current: {
    ean: string | null;
    upc: string | null;
    bricksetId: number | null;
  },
): BricksetPatch | null {
  const ean = plausibleCode(s.barcode?.EAN);
  const upc = plausibleCode(s.barcode?.UPC);
  if (!ean && !upc) return null;

  const patch: BricksetPatch = {};
  if (ean && ean !== current.ean) patch.ean = ean;
  if (upc && upc !== current.upc) patch.upc = upc;
  if (
    typeof s.setID === 'number' &&
    s.setID > 0 &&
    s.setID !== current.bricksetId
  ) {
    patch.bricksetId = s.setID;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Code ecrit en base, ou `null` s'il est implausible. Un GTIN-14 a zero de tete est ramene a ses
 * 13 chiffres : c'est l'EAN-13 de la boite, et la forme stockee doit etre celle qu'un scan
 * retrouve (`barcodeVariants` ne connait que 12 et 13 chiffres).
 */
export function plausibleCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = normalizeBarcode(raw);
  if (digits.length === 14 && digits.startsWith('0')) digits = digits.slice(1);
  return digits.length >= MIN_CODE_LENGTH && digits.length <= MAX_CODE_LENGTH
    ? digits
    : null;
}
