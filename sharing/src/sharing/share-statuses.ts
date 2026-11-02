import { SHARE_STATUSES, ShareStatus } from '../common/internal/contracts';

/**
 * Ce qu'un partage expose d'une collection : un sous-ensemble **non vide** des statuts d'item.
 *
 * Remplace les portees `all` / `owned` / `wantlist`, qui ne survivent que comme raccourcis
 * d'interface (`all` = les trois, `owned` = `['OWNED']`, `wantlist` = `['WISHLIST']`). Le
 * serveur ne stocke et ne comprend que l'ensemble - ce qui rend exprimables les combinaisons
 * que les portees interdisaient, a commencer par « possedes et desires, mais pas les ignores ».
 *
 * **Le vocabulaire vient de `common/internal/contracts.ts`**, pas d'un import vers le domaine
 * item : dans le monolithe, `ShareStatus` etait un alias d'`ItemStatus` importe de
 * `items/dto/`. Cet import traversait la couture que le decoupage supprime. Il n'y a toujours
 * qu'un seul vocabulaire - c'est simplement le contrat inter-services qui le porte maintenant,
 * ce qui est le bon endroit puisqu'il circule entre `sharing` et les catalogs.
 */
export type { ShareStatus };

/** Tout exposer. Egalement la portee implicite d'un proprietaire sur sa propre collection. */
export const ALL_SHARE_STATUSES: readonly ShareStatus[] = SHARE_STATUSES;

/**
 * Dedoublonne et remet dans l'ordre canonique de `SHARE_STATUSES`.
 *
 * Passer par la avant de stocker et avant de comparer : deux ensembles egaux doivent avoir la
 * meme representation, sans quoi `['WISHLIST','OWNED']` et `['OWNED','WISHLIST']` divergeraient
 * en base pour rien.
 */
export function normalizeStatuses(raw: readonly ShareStatus[]): ShareStatus[] {
  return SHARE_STATUSES.filter((status) => raw.includes(status));
}

/**
 * Statuts d'une entree, lus depuis la colonne JSON.
 *
 * Tolerant par construction : tout ce qui n'est pas un statut connu est ecarte, une valeur
 * abimee donne l'ensemble vide. **L'ensemble vide ne montre rien** - c'est le bon sens de la
 * defaillance pour un partage, l'inverse ouvrirait la collection entiere sur une ligne
 * corrompue.
 */
export function parseStatuses(value: unknown): ShareStatus[] {
  if (!Array.isArray(value)) return [];
  return normalizeStatuses(
    value.filter((v): v is ShareStatus =>
      SHARE_STATUSES.includes(v as ShareStatus),
    ),
  );
}

/** `true` si l'ensemble couvre tous les statuts : il n'y a alors rien a filtrer. */
export function isAllStatuses(statuses: readonly ShareStatus[]): boolean {
  return SHARE_STATUSES.every((status) => statuses.includes(status));
}

/**
 * Union de plusieurs ensembles.
 *
 * Sert quand un membre detient **plusieurs partages actifs de la meme collection** : il voit
 * la reunion de ce que chacun lui accorde, ce qui est exactement ce qu'on lui a accorde. C'est
 * ce que le modele en ensembles rend exprimable - avec les portees, `owned` et `wantlist`
 * n'etant pas comparables, il fallait en choisir une arbitrairement.
 */
export function unionStatuses(
  sets: readonly (readonly ShareStatus[])[],
): ShareStatus[] {
  return SHARE_STATUSES.filter((status) =>
    sets.some((set) => set.includes(status)),
  );
}
