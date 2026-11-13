import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { BarcodeFormat, Gtin, normalizeGtin } from '../../common/barcode/gtin';
import { ApiCacheService } from '../../common/cache/api-cache.service';
import { BggThingService } from '../../sources/bgg/bgg.service';
import { GameUpcService } from '../../sources/gameupc/gameupc.service';
import {
  CachedGameUpcLookup,
  GameUpcGame,
  GameUpcUpcInfo,
  normalizeSearch,
} from '../../sources/gameupc/gameupc.types';
import {
  BarcodeResolution,
  BarcodeResolutionStatus,
  BoardGameCandidate,
  BoardGameChoice,
  BoardGameChoiceResult,
  OFFERED_TTL_SECONDS,
  OfferedCandidates,
  offeredCacheKey,
} from './boardgame-barcode.types';

/**
 * Résolution d'un code-barres de jeu de société : EAN/UPC → jeu BoardGameGeek.
 *
 * ```
 * code scanné → normalizeGtin (400 si invalide : GameUPC ne valide rien)
 *   → GameUPC (cache → file `gameupc`)
 *       verified           → candidat unique + fiche BGG (si licence)
 *       choose_from_…      → candidats + `searchedFor` ; l'app fait choisir ou relance avec `q`
 *       bgg_info vide      → unknown ; l'app propose la recherche
 *       injoignable        → dernière réponse connue (`stale`) sinon `unavailable`
 *   → choix de l'utilisateur → file `gameupc-feedback` (vote sous pseudonyme) + fiche BGG
 * ```
 *
 * Rien ici ne touche le réseau : GameUPC et BGG passent par leurs producteurs et leurs files.
 */
@Injectable()
export class BoardGameBarcodeService {
  constructor(
    private readonly gameUpc: GameUpcService,
    private readonly bgg: BggThingService,
    private readonly cache: ApiCacheService,
    private readonly config: ConfigService,
  ) {}

  async resolve(
    code: string,
    opts: { q?: string | null; format?: BarcodeFormat } = {},
  ): Promise<BarcodeResolution> {
    const gtin = this.normalize(code, opts.format);
    const search = normalizeSearch(opts.q);

    let lookup = await this.gameUpc.lookup(gtin.upc, search);
    let stale = false;
    // La dernière réponse connue ne vaut que pour la consultation du code lui-même : servie en
    // réponse à une recherche, elle afficherait des candidats sans rapport avec la saisie.
    if (!lookup && search === null) {
      lookup = await this.gameUpc.lastKnown(gtin.upc);
      stale = lookup !== null;
    }

    if (!lookup) {
      return {
        gtin: gtin.gtin13,
        upc: gtin.upc,
        status: 'unavailable',
        searchedFor: search,
        candidates: [],
        details: null,
        stale: false,
      };
    }

    const { status, games } = classify(lookup.info);
    const candidates = games.map(toCandidate);
    if (candidates.length > 0) await this.rememberOffered(gtin.upc, games);

    return {
      gtin: gtin.gtin13,
      upc: gtin.upc,
      status,
      searchedFor: lookup.info.searchedFor,
      candidates,
      details:
        status === 'verified'
          ? await this.bgg.thing(candidates[0].bggId)
          : null,
      stale,
    };
  }

  /**
   * Enregistre le choix de l'utilisateur. Le vote part en arrière-plan ; la fiche BGG du jeu choisi
   * revient tout de suite (si licence), pour pré-remplir l'item.
   */
  async choose(
    userId: string,
    code: string,
    choice: BoardGameChoice,
    format?: BarcodeFormat,
  ): Promise<BoardGameChoiceResult> {
    const gtin = this.normalize(code, format);
    const versionId = choice.versionId ?? null;

    const offered = await this.cache.get<OfferedCandidates>(
      offeredCacheKey(gtin.upc),
    );
    const versions = offered?.games[String(choice.bggId)];
    if (!versions) {
      throw new ConflictException(
        'This game was not offered for this barcode: resolve the barcode again before choosing.',
      );
    }
    if (versionId !== null && !versions.includes(versionId)) {
      throw new ConflictException(
        'This version was not offered for this game: resolve the barcode again before choosing.',
      );
    }

    const details = await this.bgg.thing(choice.bggId);
    const reason = await this.sendFeedback(
      userId,
      gtin,
      choice.bggId,
      versionId,
    );
    return { feedback: reason ? 'skipped' : 'queued', reason, details };
  }

  private async sendFeedback(
    userId: string,
    gtin: Gtin,
    bggId: number,
    versionId: number | null,
  ): Promise<BoardGameChoiceResult['reason']> {
    // Cache seul : la consultation vient d'avoir lieu, et un choix ne doit pas attendre GameUPC.
    const current = await this.gameUpc.cachedLookup(gtin.upc);
    if (current && alreadyVerified(current, bggId, versionId)) {
      return 'already-verified';
    }

    const voterId = this.voterId(userId);
    if (!voterId || !this.gameUpc.enabled) return 'feedback-disabled';

    const queued = await this.gameUpc.enqueueVote({
      upc: gtin.upc,
      bggId,
      versionId,
      voterId,
    });
    return queued ? null : 'queue-unavailable';
  }

  /**
   * Pseudonyme GameUPC d'un utilisateur : stable (GameUPC s'en sert pour retirer en bloc les votes
   * d'un fauteur de troubles), non réversible sans le pepper, et sans rapport avec l'identifiant
   * Acervatim que GameUPC ne voit jamais. `null` sans pepper : pas de vote.
   */
  voterId(userId: string): string | null {
    const pepper = this.config.get<string>('GAMEUPC_VOTER_PEPPER');
    if (!pepper) return null;
    const digest = createHmac('sha256', pepper)
      .update(`gameupc-voter:${userId}`)
      .digest('base64url');
    return `acv-${digest.slice(0, 22)}`;
  }

  private normalize(code: string, format?: BarcodeFormat): Gtin {
    const gtin = normalizeGtin(code, format);
    if (!gtin) {
      throw new BadRequestException(
        'Invalid barcode: expected an EAN-13, EAN-8, UPC-A or UPC-E with a valid check digit.',
      );
    }
    return gtin;
  }

  private async rememberOffered(
    upc: string,
    games: GameUpcGame[],
  ): Promise<void> {
    const key = offeredCacheKey(upc);
    const offered = (await this.cache.get<OfferedCandidates>(key)) ?? {
      games: {},
    };
    for (const g of games) {
      const known = new Set(offered.games[String(g.bggId)] ?? []);
      for (const v of g.versions) known.add(v.versionId);
      offered.games[String(g.bggId)] = [...known];
    }
    await this.cache.set(key, offered, OFFERED_TTL_SECONDS);
  }
}

/**
 * Statut vu par l'app. Un statut GameUPC inconnu ne doit pas faire perdre les suggestions : avec
 * des jeux, on fait choisir ; sans, c'est un code inconnu. Pour un code vérifié, seul `bgg_info[0]`
 * fait foi.
 */
function classify(info: GameUpcUpcInfo): {
  status: Exclude<BarcodeResolutionStatus, 'unavailable'>;
  games: GameUpcGame[];
} {
  if (info.games.length === 0) return { status: 'unknown', games: [] };
  if (info.status === 'verified') {
    return { status: 'verified', games: [info.games[0]] };
  }
  return { status: 'choose', games: info.games };
}

/** Le choix confirme ce que GameUPC tient déjà pour vérifié : un vote n'apprendrait rien. */
function alreadyVerified(
  lookup: CachedGameUpcLookup,
  bggId: number,
  versionId: number | null,
): boolean {
  const { info } = lookup;
  const game = info.games[0];
  if (info.status !== 'verified' || !game || game.bggId !== bggId) return false;
  if (versionId === null) return true;
  return (
    game.versionStatus === 'verified' &&
    game.versions[0]?.versionId === versionId
  );
}

function versionStatusOf(g: GameUpcGame): BoardGameCandidate['versionStatus'] {
  switch (g.versionStatus) {
    case 'choose_from_versions':
      return 'choose';
    case 'verified':
      return 'verified';
    case 'none':
      return 'none';
    default:
      return null;
  }
}

function toCandidate(g: GameUpcGame): BoardGameCandidate {
  return {
    bggId: g.bggId,
    name: g.name,
    published: g.published,
    thumbnailUrl: g.thumbnailUrl,
    imageUrl: g.imageUrl,
    pageUrl: g.pageUrl ?? `https://boardgamegeek.com/boardgame/${g.bggId}`,
    confidence: g.confidence,
    versionStatus: versionStatusOf(g),
    versions: g.versions.map((v) => ({
      versionId: v.versionId,
      name: v.name,
      published: v.published,
      language: v.language,
      thumbnailUrl: v.thumbnailUrl,
      confidence: v.confidence,
    })),
  };
}
