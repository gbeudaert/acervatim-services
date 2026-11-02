import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { ShareCodeInvalidException } from '../common/errors';
import { HashService } from '../common/crypto/hash.service';
import { CollectionTypeCode } from '../common/internal/contracts';
import { AuditClientService } from '../common/internal/audit-client.service';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogClientService } from './catalog-client.service';
import { CreateShareDto } from './dto/create-share.dto';
import { normalizeStatuses, parseStatuses, ShareStatus } from './share-statuses';

/** Une collection exposee par un partage, telle que la voit le **proprietaire**. */
export interface ShareEntryView {
  collectionId: string;
  name: string;
  type: string;
  statuses: ShareStatus[];
}

/**
 * Idem pour un **membre**, avec le nombre d'elements qu'il verra effectivement.
 *
 * Le proprietaire n'a pas ce compte : sur son ecran de gestion, ce qui l'interesse est
 * *quelles* collections et *quels* statuts. Le calculer pour lui couterait un appel reseau par
 * entree et par partage, sur une liste non plafonnee - c'etait deja l'argument dans le
 * monolithe, ou ce n'etait « qu' » une requete SQL.
 *
 * `itemCount` est `null` quand le catalog n'a pas repondu. Pas `0` : un membre doit pouvoir
 * distinguer « ce partage est vide » de « je n'ai pas pu compter ».
 */
export interface ReceivedEntryView extends ShareEntryView {
  itemCount: number | null;
}

export interface ShareMemberView {
  /** UUID opaque : aucun email, aucun nom - il n'y en a pas en base (invariant privacy). */
  memberUserId: string;
  redeemedAt: Date;
}

export interface ShareView {
  id: string;
  /** Libelle du proprietaire. Ne sort que vers lui. */
  label: string | null;
  maxUses: number;
  usedCount: number;
  expiresAt: number | null;
  createdAt: Date;
  collections: ShareEntryView[];
  members: ShareMemberView[];
}

export interface CreatedShare extends ShareView {
  /** Code en clair. Retourne UNE seule fois, au proprietaire qui cree le partage. */
  code: string;
}

export interface ReceivedShare {
  shareId: string;
  /** Libelle du **membre**. Celui du proprietaire ne lui est jamais transmis. */
  label: string | null;
  redeemedAt: Date;
  collections: ReceivedEntryView[];
}

export interface RedeemedShare extends ReceivedShare {
  /** `true` si le membre avait deja rejoint : le redeem est idempotent. */
  alreadyMember: boolean;
}

/**
 * Les entrees sortent triees par nom de collection.
 *
 * Sans `orderBy`, Prisma les rend dans l'ordre de la cle composite `[shareId, collectionId]`,
 * c'est-a-dire par UUID : arbitraire, et different d'un partage a l'autre. Le tri se fait
 * maintenant sur la colonne denormalisee `collectionName` - dans le monolithe il passait par
 * la jointure vers `collections`, qui n'existe plus.
 */
const ENTRY_INCLUDE = {
  entries: { orderBy: { collectionName: 'asc' } },
} as const;

const ACTIVE_MEMBERS = {
  where: { revokedAt: null },
  orderBy: { redeemedAt: 'asc' },
  select: { memberUserId: true, redeemedAt: true },
} as const;

interface EntryRow {
  collectionId: string;
  statuses: unknown;
  collectionName: string;
  typeCode: string;
}

function toEntryView(row: EntryRow): ShareEntryView {
  return {
    collectionId: row.collectionId,
    name: row.collectionName,
    type: row.typeCode,
    statuses: parseStatuses(row.statuses),
  };
}

@Injectable()
export class SharingService implements OnModuleInit {
  private readonly logger = new Logger(SharingService.name);
  private pepper!: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly hash: HashService,
    private readonly auditLog: AuditClientService,
    private readonly catalogs: CatalogClientService,
  ) {}

  onModuleInit() {
    const pepper = this.config.get<string>('SHARE_CODE_PEPPER');
    if (!pepper || pepper.length < 32) {
      throw new Error('SHARE_CODE_PEPPER must be set (>= 32 chars)');
    }
    this.pepper = pepper;
  }

  private hashCode(code: string): string {
    return this.hash.hmacSha256Hex(this.pepper, code);
  }

  /** 18 octets aleatoires -> 24 chars base64url. ~144 bits : hors de portee d'un balayage. */
  private generateCode(): string {
    return randomBytes(18).toString('base64url');
  }

  /**
   * Verifie que **toutes** les collections sont au requerant, et rend leur nom et leur type.
   *
   * Dans le monolithe c'etait un `count` sur `collections`. C'est maintenant un appel par
   * collection vers les catalogs - le prix de la separation des schemas, paye a la creation
   * d'un partage, operation rare, et amorti ensuite par la denormalisation.
   *
   * 404 si l'une n'existe pas OU n'appartient pas au requerant, indistinguables et **sans
   * dire laquelle** : repondre plus finement ferait de la creation de partage un test
   * d'existence.
   */
  private async resolveOwnedCollections(
    userId: string,
    collectionIds: string[],
  ): Promise<Map<string, { name: string; typeCode: CollectionTypeCode }>> {
    const found = await Promise.all(
      collectionIds.map((id) => this.catalogs.findCollection(id)),
    );
    const out = new Map<string, { name: string; typeCode: CollectionTypeCode }>();
    for (const summary of found) {
      if (!summary || summary.ownerUserId !== userId) {
        throw new NotFoundException('Collection not found');
      }
      out.set(summary.collectionId, {
        name: summary.name,
        typeCode: summary.typeCode,
      });
    }
    return out;
  }

  /** 404 si le partage n'existe pas OU n'est pas au requerant - meme convention. */
  private async assertOwnedShare(userId: string, shareId: string) {
    const share = await this.prisma.collectionShare.findFirst({
      where: { id: shareId, ownerUserId: userId },
      select: { id: true, revokedAt: true },
    });
    if (!share) {
      throw new NotFoundException('Share not found');
    }
    return share;
  }

  async create(userId: string, dto: CreateShareDto): Promise<CreatedShare> {
    const requested = dto.collections.map((e) => ({
      collectionId: e.collectionId,
      statuses: normalizeStatuses(e.statuses),
    }));
    const summaries = await this.resolveOwnedCollections(
      userId,
      requested.map((e) => e.collectionId),
    );

    const code = this.generateCode();
    const share = await this.prisma.collectionShare.create({
      data: {
        ownerUserId: userId,
        codeHash: this.hashCode(code),
        label: dto.label ?? null,
        maxUses: dto.maxUses ?? 1,
        expiresAt: dto.expiresAt != null ? BigInt(dto.expiresAt) : null,
        entries: {
          create: requested.map((e) => ({
            collectionId: e.collectionId,
            statuses: e.statuses,
            // Denormalise ici : sans jointure possible, c'est le seul moment ou ces deux
            // valeurs sont connues sans appel supplementaire.
            collectionName: summaries.get(e.collectionId)!.name,
            typeCode: summaries.get(e.collectionId)!.typeCode,
          })),
        },
      },
      include: ENTRY_INCLUDE,
    });

    // Ni le libelle ni les identifiants de collection : l'audit dit qu'un partage a ete cree
    // et de quelle taille, pas ce qu'il nomme.
    await this.auditLog.record({
      userId,
      action: 'share.create',
      target: share.id,
      metadata: { collections: requested.length },
    });
    this.logger.log(
      `share.create share=${share.id.slice(0, 8)}... collections=${requested.length} maxUses=${share.maxUses}`,
    );

    return { ...this.toView(share, []), code };
  }

  /**
   * Partages non revoques que j'ai emis, membres actifs inclus. `collectionId` restreint aux
   * partages exposant cette collection - de quoi ancrer un ecran sur une collection donnee.
   *
   * Les partages **expires** restent listes : le proprietaire doit voir pourquoi son code ne
   * prend plus, et `expiresAt` le lui dit. Seule la revocation fait disparaitre la ligne.
   *
   * **Aucun appel aux catalogs ici** : les noms viennent des colonnes denormalisees, et
   * peuvent donc avoir vieilli si le proprietaire a renomme une collection depuis. C'est le
   * prix assume de ne pas faire N appels reseau sur un ecran de gestion ; la lecture d'un
   * membre, qui appelle le catalog pour les comptes, realigne la copie au passage.
   */
  async list(userId: string, collectionId?: string): Promise<ShareView[]> {
    if (collectionId) {
      await this.resolveOwnedCollections(userId, [collectionId]);
    }
    const shares = await this.prisma.collectionShare.findMany({
      where: {
        ownerUserId: userId,
        revokedAt: null,
        ...(collectionId ? { entries: { some: { collectionId } } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: { ...ENTRY_INCLUDE, members: ACTIVE_MEMBERS },
    });
    return shares.map((share) => this.toView(share, share.members));
  }

  /**
   * Renomme un partage que j'ai emis.
   *
   * Le libelle est le seul champ modifiable apres coup : changer les collections ou les
   * statuts d'un partage vivant modifierait sans le dire ce que ses membres voient deja. Un
   * changement de portee passe par une revocation et un nouveau code - visible des deux cotes.
   */
  async updateLabel(
    userId: string,
    shareId: string,
    label: string | null,
  ): Promise<ShareView> {
    await this.assertOwnedShare(userId, shareId);
    const share = await this.prisma.collectionShare.update({
      where: { id: shareId },
      data: { label },
      include: { ...ENTRY_INCLUDE, members: ACTIVE_MEMBERS },
    });
    return this.toView(share, share.members);
  }

  /**
   * Revoque le partage entier : le code cesse de prendre ET tous les membres perdent l'acces.
   * Marquage, pas suppression - la trace de ce qui a ete partage doit survivre a la
   * revocation. Idempotent : re-revoquer ne change rien et ne re-audite pas.
   */
  async revoke(userId: string, shareId: string): Promise<void> {
    const share = await this.assertOwnedShare(userId, shareId);
    if (share.revokedAt) return;

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.collectionShare.update({
        where: { id: shareId },
        data: { revokedAt: now },
      }),
      this.prisma.collectionShareMember.updateMany({
        where: { shareId, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);

    await this.auditLog.record({
      userId,
      action: 'share.revoke',
      target: shareId,
    });
    this.logger.log(`share.revoke share=${shareId.slice(0, 8)}...`);
  }

  /**
   * Ejecte un membre sans toucher au partage : le code reste valide pour les autres, et le
   * membre ejecte ne peut pas revenir avec (cf. `redeem`).
   */
  async revokeMember(
    userId: string,
    shareId: string,
    memberUserId: string,
  ): Promise<void> {
    await this.assertOwnedShare(userId, shareId);

    const member = await this.prisma.collectionShareMember.findUnique({
      where: { shareId_memberUserId: { shareId, memberUserId } },
      select: { revokedAt: true },
    });
    if (!member) {
      throw new NotFoundException('Share member not found');
    }
    if (member.revokedAt) return;

    await this.prisma.collectionShareMember.update({
      where: { shareId_memberUserId: { shareId, memberUserId } },
      data: { revokedAt: new Date() },
    });

    await this.auditLog.record({
      userId,
      action: 'share.member.revoke',
      target: shareId,
    });
    this.logger.log(
      `share.member.revoke share=${shareId.slice(0, 8)}... member=${memberUserId.slice(0, 8)}...`,
    );
  }

  /**
   * Consomme un code pour `userId`.
   *
   * - **Idempotent** : un membre deja actif re-appelle sans reconsommer une place. Un `label`
   *   fourni au passage est tout de meme applique - c'est le seul effet utile d'un redeem
   *   repete.
   * - **Atomique** : controles + increment de `usedCount` + creation du membre dans la meme
   *   transaction, l'increment garde par un `updateMany` conditionnel - deux redeems
   *   concurrents sur la derniere place ne peuvent pas passer tous deux.
   * - **Aucun oracle** : tout refus lie au code sort en `ShareCodeInvalidException`, un seul
   *   statut, un seul message. Seul le proprietaire obtient une erreur distincte (400), et
   *   pour cause : il connait deja l'existence de son propre code.
   */
  async redeem(
    rawCode: string,
    userId: string,
    label: string | null = null,
  ): Promise<RedeemedShare> {
    const codeHash = this.hashCode(rawCode);

    const result = await this.prisma.$transaction(async (tx) => {
      const share = await tx.collectionShare.findUnique({
        where: { codeHash },
        include: ENTRY_INCLUDE,
      });
      if (!share) {
        throw new ShareCodeInvalidException();
      }
      if (share.ownerUserId === userId) {
        throw new BadRequestException(
          'Impossible de rejoindre son propre partage',
        );
      }
      if (share.revokedAt) {
        throw new ShareCodeInvalidException();
      }
      if (share.expiresAt != null && Number(share.expiresAt) < Date.now()) {
        throw new ShareCodeInvalidException();
      }

      const existing = await tx.collectionShareMember.findUnique({
        where: {
          shareId_memberUserId: { shareId: share.id, memberUserId: userId },
        },
      });
      if (existing) {
        // Membre ejecte : le code ne le fait pas revenir, sinon revoquer un membre ne
        // servirait a rien tant que le partage vit.
        if (existing.revokedAt) {
          throw new ShareCodeInvalidException();
        }
        if (label !== null) {
          await tx.collectionShareMember.update({
            where: {
              shareId_memberUserId: { shareId: share.id, memberUserId: userId },
            },
            data: { label },
          });
        }
        return {
          shareId: share.id,
          label: label ?? existing.label,
          redeemedAt: existing.redeemedAt,
          entries: share.entries,
          alreadyMember: true,
        };
      }

      if (share.usedCount >= share.maxUses) {
        throw new ShareCodeInvalidException();
      }
      // Garde optimiste : n'incremente que si la place est encore libre.
      const bumped = await tx.collectionShare.updateMany({
        where: { id: share.id, usedCount: { lt: share.maxUses } },
        data: { usedCount: { increment: 1 } },
      });
      if (bumped.count === 0) {
        throw new ShareCodeInvalidException();
      }

      const member = await tx.collectionShareMember.create({
        data: { shareId: share.id, memberUserId: userId, label },
      });

      return {
        shareId: share.id,
        label: member.label,
        redeemedAt: member.redeemedAt,
        entries: share.entries,
        alreadyMember: false,
      };
    });

    if (!result.alreadyMember) {
      await this.auditLog.record({
        userId,
        action: 'share.redeem',
        target: result.shareId,
      });
      this.logger.log(
        `share.redeem share=${result.shareId.slice(0, 8)}... member=${userId.slice(0, 8)}...`,
      );
    }

    // Comptes hors transaction, et plus encore qu'avant : ce sont maintenant des appels
    // reseau, qui n'ont rien a faire dans la section critique du redeem - laquelle ne garde
    // que l'increment de `usedCount`.
    return {
      shareId: result.shareId,
      label: result.label,
      redeemedAt: result.redeemedAt,
      collections: await this.toReceivedEntries(result.entries),
      alreadyMember: result.alreadyMember,
    };
  }

  /**
   * Partages que j'ai rejoints et qui vivent encore.
   *
   * `expiresAt` n'entre pas dans le filtre : il borne l'usage du **code**, pas l'adhesion
   * deja acquise. Une adhesion ne tombe que sur revocation - du partage ou du membre.
   *
   * Les comptes de **toutes** les entrees de **tous** les partages sont demandes en un seul
   * lot, groupe par catalog : un membre avec cinq partages de trois collections declenche
   * trois appels reseau, pas quinze.
   */
  async listReceived(userId: string): Promise<ReceivedShare[]> {
    const memberships = await this.prisma.collectionShareMember.findMany({
      where: {
        memberUserId: userId,
        revokedAt: null,
        share: { revokedAt: null },
      },
      orderBy: { redeemedAt: 'desc' },
      include: { share: { include: ENTRY_INCLUDE } },
    });

    const allEntries = memberships.flatMap((m) => m.share.entries);
    const counts = await this.fetchCounts(allEntries);

    return memberships.map((m) => ({
      shareId: m.shareId,
      label: m.label,
      redeemedAt: m.redeemedAt,
      collections: m.share.entries.map((e) => this.withCount(e, counts)),
    }));
  }

  /** Renomme, cote membre, un partage que j'ai rejoint. Le proprietaire ne le voit pas. */
  async updateMembershipLabel(
    userId: string,
    shareId: string,
    label: string | null,
  ): Promise<ReceivedShare> {
    const membership = await this.prisma.collectionShareMember.findFirst({
      where: {
        shareId,
        memberUserId: userId,
        revokedAt: null,
        share: { revokedAt: null },
      },
      select: { shareId: true },
    });
    if (!membership) {
      throw new NotFoundException('Share not found');
    }
    const updated = await this.prisma.collectionShareMember.update({
      where: { shareId_memberUserId: { shareId, memberUserId: userId } },
      data: { label },
      include: { share: { include: ENTRY_INCLUDE } },
    });
    return {
      shareId: updated.shareId,
      label: updated.label,
      redeemedAt: updated.redeemedAt,
      collections: await this.toReceivedEntries(updated.share.entries),
    };
  }

  private toView(
    share: {
      id: string;
      label: string | null;
      maxUses: number;
      usedCount: number;
      expiresAt: bigint | null;
      createdAt: Date;
      entries: EntryRow[];
    },
    members: ShareMemberView[],
  ): ShareView {
    return {
      id: share.id,
      label: share.label,
      maxUses: share.maxUses,
      usedCount: share.usedCount,
      expiresAt: share.expiresAt != null ? Number(share.expiresAt) : null,
      createdAt: share.createdAt,
      collections: share.entries.map(toEntryView),
      members,
    };
  }

  private async toReceivedEntries(
    entries: EntryRow[],
  ): Promise<ReceivedEntryView[]> {
    const counts = await this.fetchCounts(entries);
    return entries.map((e) => this.withCount(e, counts));
  }

  private async fetchCounts(entries: EntryRow[]) {
    return this.catalogs.countItems(
      entries.map((e) => ({
        collectionId: e.collectionId,
        typeCode: e.typeCode as CollectionTypeCode,
        statuses: parseStatuses(e.statuses),
      })),
    );
  }

  /**
   * Assemble la vue d'un membre. Le nom courant rendu par le catalog l'emporte sur la copie
   * denormalisee : c'est le point ou la copie se realigne, sans appel supplementaire.
   *
   * La base n'est pas mise a jour au passage - une ecriture par lecture pour un libelle
   * d'affichage ne vaut pas son cout, et la prochaine lecture corrigera de la meme facon.
   */
  private withCount(
    row: EntryRow,
    counts: Map<string, { count: number | null; name: string | null }>,
  ): ReceivedEntryView {
    const view = toEntryView(row);
    const fresh = counts.get(row.collectionId);
    return {
      ...view,
      name: fresh?.name ?? view.name,
      itemCount: fresh?.count ?? null,
    };
  }
}
