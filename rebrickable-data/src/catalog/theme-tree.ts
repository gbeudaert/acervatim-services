/**
 * L'arbre des themes Rebrickable.
 *
 * C'est ce qui rend `theme=technic` resoluble sans coder en dur un `theme_id` : le decoupage par
 * « type de set » (Technic, Architecture, City...) EST la taxonomie de Rebrickable, a ceci pres
 * qu'elle est hierarchique - "Star Wars" existe sous plusieurs parents, "Technic" a une
 * trentaine de sous-themes. Filtrer sur le seul theme de tete raterait la majorite des sets
 * attendus : on resout toujours vers le theme **et sa descendance**.
 *
 * Deux moities, toutes deux pures :
 *  - {@link buildThemeTree} calcule `path`, `depth` et `slug` sur la liste **complete** du CSV,
 *    a chaque import ;
 *  - {@link ThemeIndex} sert les lectures (resolution d'un slug, descendance, enfants).
 */

/** Une ligne de `themes.csv` : `id,name,parent_id`. */
export interface RawTheme {
  id: number;
  name: string;
  parentId: number | null;
}

export interface ThemeNode {
  id: number;
  name: string;
  slug: string;
  parentId: number | null;
  path: string;
  depth: number;
}

/**
 * Theme tel que l'index le tient. `retired` : absent du dernier `themes.csv`. Sa ligne reste (des
 * sets le referencent encore), mais il n'est plus ni liste ni resolvable par slug.
 */
export interface IndexedTheme extends ThemeNode {
  retired: boolean;
}

/** Garde-fou : une reference circulaire ou un arbre aberrant ne doit pas boucler. */
const MAX_ANCESTORS = 10;
const PATH_SEPARATOR = ' / ';
/** Largeur de la colonne `path`. */
const PATH_MAX_LENGTH = 512;
/** Largeur de la colonne `slug`. */
export const SLUG_MAX_LENGTH = 255;

/**
 * Calcule `path`, `depth` et `slug` de chaque theme.
 *
 * Les noms se repetent dans l'arbre ("Technic" existe sous plusieurs parents) : un slug nu ne
 * peut pas etre unique. Le **premier id** d'un nom garde le slug nu, les suivants prennent
 * `-{id}` - c'est ce qui laisse `theme=technic` designer le theme de tete. Le tri par id rend
 * l'attribution stable d'un import a l'autre : Rebrickable n'attribue que des ids croissants.
 *
 * Un id en double dans le CSV est dedoublonne (la derniere ligne gagne) : sinon le second
 * passage prendrait un slug suffixe, puis l'upsert ecraserait le premier.
 */
export function buildThemeTree(raw: RawTheme[]): ThemeNode[] {
  const byId = new Map<number, RawTheme>();
  for (const theme of raw) byId.set(theme.id, theme);
  const usedSlugs = new Set<string>();
  const sorted = [...byId.values()].sort((a, b) => a.id - b.id);

  return sorted.map((theme) => {
    const path = buildPath(theme, byId);
    const slug = uniqueSlug(slugify(theme.name), theme.id, (candidate) =>
      usedSlugs.has(candidate),
    );
    usedSlugs.add(slug);

    return {
      id: theme.id,
      name: theme.name,
      slug,
      parentId: theme.parentId,
      path: path.join(PATH_SEPARATOR).slice(0, PATH_MAX_LENGTH),
      depth: path.length - 1,
    };
  });
}

/**
 * Premier slug libre parmi `base`, `base-{id}`, `base-{id}-2`, `base-{id}-3`... La base est
 * tronquee **avant** l'ajout du suffixe, pour que le tout tienne dans les 255 caracteres de la
 * colonne : un nom long suffixe deborderait sinon, et l'import entier echouerait.
 */
export function uniqueSlug(
  base: string,
  id: number,
  isTaken: (slug: string) => boolean,
): string {
  const root = base || 'theme';
  let candidate = fit(root, '');
  if (!isTaken(candidate)) return candidate;
  candidate = fit(root, `-${id}`);
  for (let n = 2; isTaken(candidate); n++) candidate = fit(root, `-${id}-${n}`);
  return candidate;
}

function fit(base: string, suffix: string): string {
  const head = base
    .slice(0, SLUG_MAX_LENGTH - suffix.length)
    .replace(/-+$/, '');
  return `${head || 'theme'}${suffix}`;
}

/** Chemin racine -> feuille. Borne a {@link MAX_ANCESTORS} ancetres, garde anti-cycle. */
function buildPath(theme: RawTheme, byId: Map<number, RawTheme>): string[] {
  const path = [theme.name];
  const seen = new Set<number>([theme.id]);
  let current = theme;
  for (let i = 0; i < MAX_ANCESTORS; i++) {
    const parentId = current.parentId;
    if (parentId === null || seen.has(parentId)) break;
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

/**
 * Lecture de l'arbre, construite une fois par import et tenue en memoire.
 *
 * Un theme **retire** (absent du dernier CSV) reste trouvable par id - un set peut encore le
 * referencer, et doit pouvoir l'afficher - mais n'est plus liste (`topLevel`, `children`) ni
 * resolvable par slug (`resolve`). `descendantIds` le parcourt toujours : les sets qui y sont
 * classes sont bien des sets du theme parent.
 */
export class ThemeIndex {
  private readonly byId = new Map<number, IndexedTheme>();
  private readonly bySlug = new Map<string, IndexedTheme>();
  private readonly childrenOf = new Map<number, number[]>();

  constructor(nodes: Array<ThemeNode & { retired?: boolean }>) {
    for (const raw of nodes) {
      const node: IndexedTheme = { ...raw, retired: raw.retired ?? false };
      this.byId.set(node.id, node);
      if (!node.retired) this.bySlug.set(node.slug, node);
      if (node.parentId !== null) {
        const siblings = this.childrenOf.get(node.parentId) ?? [];
        siblings.push(node.id);
        this.childrenOf.set(node.parentId, siblings);
      }
    }
  }

  get size(): number {
    return this.byId.size;
  }

  findById(id: number): IndexedTheme | null {
    return this.byId.get(id) ?? null;
  }

  /**
   * Resout un libelle ("technic", "Technic", "star-wars") vers un theme. Tolerant sur la casse
   * et la ponctuation : le slug est la forme canonique.
   */
  resolve(input: string): IndexedTheme | null {
    return this.bySlug.get(slugify(input)) ?? null;
  }

  /** Le theme et toute sa descendance, en ids - la forme attendue par un filtre `theme_id`. */
  descendantIds(rootId: number): number[] {
    const out: number[] = [];
    const seen = new Set<number>();
    const stack = [rootId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      for (const child of this.childrenOf.get(id) ?? []) stack.push(child);
    }
    return out;
  }

  /** Themes de tete (profondeur 0), tries par nom - le selecteur « type de set » de l'app. */
  topLevel(): IndexedTheme[] {
    return [...this.byId.values()]
      .filter((t) => t.depth === 0 && !t.retired)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  children(parentId: number): IndexedTheme[] {
    return (this.childrenOf.get(parentId) ?? [])
      .map((id) => this.byId.get(id)!)
      .filter((t) => !t.retired)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
