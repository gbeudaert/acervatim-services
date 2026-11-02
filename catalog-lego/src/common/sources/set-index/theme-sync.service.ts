import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { LegoTheme } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  RebrickableCallContext,
  RebrickableService,
} from '../rebrickable/rebrickable.service';
import { RebrickableTheme } from '../rebrickable/rebrickable.types';

/** Garde-fou de boucle : l'arbre Rebrickable tient largement sous ce plafond de pages. */
const MAX_PAGES = 20;
const PAGE_SIZE = 1000;

export interface ThemeNode {
  id: number;
  name: string;
  slug: string;
  path: string;
  depth: number;
  parentId: number | null;
}

/**
 * L'arbre des themes Rebrickable, synchronise en base et tenu en memoire.
 *
 * C'est ce qui rend `?theme=technic` resoluble sans coder en dur un `theme_id` : le decoupage
 * par « type de set » que demande l'utilisateur (Technic, Architecture, City...) EST la
 * taxonomie de themes de Rebrickable, a ceci pres qu'elle est hierarchique - "Star Wars" existe
 * sous plusieurs parents, "Technic" a une trentaine de sous-themes. Filtrer sur le seul id du
 * theme de tete raterait donc la majorite des sets attendus : on resout toujours vers le theme
 * **et sa descendance**.
 */
@Injectable()
export class ThemeSyncService implements OnModuleInit {
  private readonly logger = new Logger(ThemeSyncService.name);
  private byId = new Map<number, ThemeNode>();
  private bySlug = new Map<string, ThemeNode>();
  private childrenOf = new Map<number, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly rebrickable: RebrickableService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  /** Recharge le cache memoire depuis la base. Idempotent, appele au boot et apres chaque sync. */
  async reload(): Promise<void> {
    const rows = await this.prisma.legoTheme.findMany();
    this.byId = new Map();
    this.bySlug = new Map();
    this.childrenOf = new Map();
    for (const r of rows) {
      const node = toNode(r);
      this.byId.set(node.id, node);
      this.bySlug.set(node.slug, node);
      if (node.parentId !== null) {
        const siblings = this.childrenOf.get(node.parentId) ?? [];
        siblings.push(node.id);
        this.childrenOf.set(node.parentId, siblings);
      }
    }
    this.logger.log(`themes: ${rows.length} en cache`);
  }

  isEmpty(): boolean {
    return this.byId.size === 0;
  }

  findById(id: number): ThemeNode | null {
    return this.byId.get(id) ?? null;
  }

  /**
   * Resout un libelle utilisateur ("technic", "Technic", "star-wars") vers un theme.
   * Tolerant sur la casse et la ponctuation : le slug est la forme canonique.
   */
  resolve(input: string): ThemeNode | null {
    return this.bySlug.get(slugify(input)) ?? null;
  }

  /** Le theme et toute sa descendance, en ids - la forme attendue par un filtre `theme_id`. */
  descendantIds(rootId: number): number[] {
    const out: number[] = [];
    const stack = [rootId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      out.push(id);
      for (const child of this.childrenOf.get(id) ?? []) stack.push(child);
    }
    return out;
  }

  /** Themes de tete (profondeur 0), tries par nom - le selecteur « type de set » de l'app. */
  topLevel(): ThemeNode[] {
    return [...this.byId.values()]
      .filter((t) => t.depth === 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  children(parentId: number): ThemeNode[] {
    return (this.childrenOf.get(parentId) ?? [])
      .map((id) => this.byId.get(id)!)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Moissonne l'arbre complet et le persiste. `path` et `depth` sont pre-calcules ici pour que
   * l'affichage d'un resultat de recherche ne remonte pas l'arbre a chaque ligne.
   */
  async sync(ctx: RebrickableCallContext): Promise<number> {
    const raw: RebrickableTheme[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.rebrickable.fetchThemesPage(ctx, page, PAGE_SIZE);
      raw.push(...res.results);
      if (!res.next) break;
    }

    const byId = new Map(raw.map((t) => [t.id, t]));
    const usedSlugs = new Set<string>();

    for (const theme of raw) {
      const path = buildPath(theme, byId);
      // Les noms se repetent dans l'arbre ("Star Wars" sous plusieurs parents) : un slug nu
      // ne peut pas etre unique. On desambigue par l'id, en gardant le slug nu au premier
      // arrive - c'est ce qui laisse `?theme=technic` fonctionner tel quel.
      let slug = slugify(theme.name);
      if (usedSlugs.has(slug)) slug = `${slug}-${theme.id}`;
      usedSlugs.add(slug);

      const data = {
        name: theme.name,
        slug,
        parentId: theme.parent_id ?? null,
        path: path.join(' / ').slice(0, 512),
        depth: path.length - 1,
      };
      await this.prisma.legoTheme.upsert({
        where: { id: theme.id },
        create: { id: theme.id, ...data },
        update: data,
      });
    }

    await this.reload();
    return raw.length;
  }
}

function toNode(r: LegoTheme): ThemeNode {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    path: r.path,
    depth: r.depth,
    parentId: r.parentId,
  };
}

/** Chemin racine -> feuille. Borne a 10 niveaux : une reference circulaire ne doit pas boucler. */
function buildPath(
  theme: RebrickableTheme,
  byId: Map<number, RebrickableTheme>,
): string[] {
  const path = [theme.name];
  const seen = new Set<number>([theme.id]);
  let current = theme;
  for (let i = 0; i < 10; i++) {
    const parentId = current.parent_id;
    if (parentId === null || parentId === undefined || seen.has(parentId))
      break;
    const parent = byId.get(parentId);
    if (!parent) break;
    path.unshift(parent.name);
    seen.add(parent.id);
    current = parent;
  }
  return path;
}

/** Marques diacritiques combinantes (U+0300..U+036F), separees par la normalisation NFD. */
const COMBINING_START = 0x300;
const COMBINING_END = 0x36f;

/** "Star Wars" -> "star-wars" ; "Technic" -> "technic". Diacritiques aplaties. */
export function slugify(input: string): string {
  const decomposed = input.normalize('NFD').toLowerCase();
  let flattened = '';
  for (const ch of decomposed) {
    const cp = ch.codePointAt(0)!;
    if (cp < COMBINING_START || cp > COMBINING_END) flattened += ch;
  }

  let out = '';
  let pendingDash = false;
  for (const ch of flattened) {
    const isAlnum = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
    if (isAlnum) {
      if (pendingDash && out.length > 0) out += '-';
      pendingDash = false;
      out += ch;
    } else {
      pendingDash = true;
    }
  }
  return out;
}
