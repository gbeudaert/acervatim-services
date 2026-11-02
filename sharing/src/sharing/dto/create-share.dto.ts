import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { SHARE_STATUSES } from '../../common/internal/contracts';
import { shareLabel } from './share-label';

/**
 * Borne de validation du nombre de collections dans un partage.
 *
 * Dans le monolithe, cette borne etait `TECHNICAL_LIMITS.collections`, importe du service de
 * plafonds - lequel vit maintenant dans les catalogs. Reprendre la valeur ici est un
 * decouplage assume : c'est un garde-fou contre un corps de requete absurde, pas la limite
 * produit. Si le plafond des catalogs change, celui-ci n'a pas a suivre - au pire il refuse
 * un partage qui n'aurait de toute facon aucune collection a exposer.
 */
const MAX_COLLECTIONS_PER_SHARE = 100;

/** Une collection exposee par le partage, avec les statuts qu'elle laisse voir. */
export const ShareEntrySchema = z
  .object({
    collectionId: z.string().uuid(),
    /**
     * Non vide : un partage qui n'expose aucun statut d'une collection n'expose pas cette
     * collection - il faut alors ne pas l'inclure, ce que le client doit dire explicitement.
     */
    statuses: z
      .array(z.enum(SHARE_STATUSES))
      .min(1)
      .max(SHARE_STATUSES.length),
  })
  .strict();

export const CreateShareSchema = z
  .object({
    /** Aide-memoire du proprietaire. Jamais transmis aux membres. */
    label: shareLabel().optional(),
    collections: z
      .array(ShareEntrySchema)
      .min(1)
      .max(MAX_COLLECTIONS_PER_SHARE)
      .refine(
        (entries) =>
          new Set(entries.map((e) => e.collectionId)).size === entries.length,
        { message: 'a collection can only appear once in a share' },
      ),
    /**
     * Nombre de membres pouvant consommer le code. Le plafond 100 est une borne technique de
     * validation, pas une limite produit : le nombre de partages qu'un utilisateur peut creer
     * n'est pas plafonne.
     */
    maxUses: z.number().int().min(1).max(100).optional(),
    /** epoch ms ; null/absent = le code ne perime jamais. */
    expiresAt: z.number().int().min(0).nullable().optional(),
  })
  .strict();

export class CreateShareDto extends createZodDto(CreateShareSchema) {}
