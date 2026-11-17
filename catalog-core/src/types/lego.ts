import { z } from 'zod';
import { resolveItemStatus } from '../item-user-data.schema';
import {
  CollectionTypeProfile,
  ItemProjectionRow,
  LightItem,
  optionalUrl,
} from './common';

/**
 * lego - type plat : un item est une boite. Deux exemplaires du meme set sont deux items, comme
 * deux pressages d'un disque.
 *
 * Les identifiants externes ne vont pas ici mais dans `sources[]` (regle du vinyle) : le numero
 * canonique Rebrickable (`42131-1`) avec `provider: 'rebrickable'`, le code-barres scanne avec
 * `provider: 'barcode'`. `setNumber` n'est pas un identifiant : c'est le numero imprime sur la
 * boite, affiche tel quel.
 *
 * Pas de donnee perso propre au LEGO (boite scellee, montee, incomplete) : decision du
 * 2026-11-17, le champ `note` suffit d'abord. Le jour venu, elles passeront par un schema
 * `userData` porte par le profil, pas par un champ de `ItemUserDataSchema`, commun a tous les
 * types.
 */
export const LegoItemSchema = z
  .object({
    type: z.literal('lego'),
    title: z.string().min(1).max(512),
    // Numero sans suffixe de version, tel qu'imprime sur la boite : "42131".
    setNumber: z.string().min(1).max(32).nullable().default(null),
    year: z.number().int().min(1940).max(2100).nullable().default(null),
    // Chemin du theme depuis la racine, "Technic / Star Wars", affiche en sous-titre.
    theme: z.string().max(512).nullable().default(null),
    // Le slug d'un theme n'est pas stable d'un import a l'autre, son id l'est.
    themeId: z.number().int().nonnegative().nullable().default(null),
    numParts: z.number().int().nonnegative().nullable().default(null),
    minifigs: z.number().int().nonnegative().nullable().default(null),
    coverUrl: optionalUrl(),
  })
  .strict();

export const legoProfile: CollectionTypeProfile = {
  code: 'lego',
  itemSchema: LegoItemSchema,
  hierarchy: [],
  /** Pas de `playCount` : il n'a pas de sens pour une boite. */
  toListProjection(row: ItemProjectionRow): LightItem {
    const u = row.unifiedData;
    return {
      id: row.id,
      type: 'lego',
      title: u.title ?? null,
      setNumber: u.setNumber ?? null,
      year: u.year ?? null,
      theme: u.theme ?? null,
      coverUrl: u.coverUrl ?? null,
      status: resolveItemStatus(row.userData),
    };
  },
};
