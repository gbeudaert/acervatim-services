import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Meme forme que le `SearchQuerySchema` du monolithe - `type` inclus, bien que ce service ne
 * serve que `lego`. Le parametre reste exige pour que l'app envoie exactement la meme requete
 * qu'aujourd'hui : c'est le gateway qui route sur `type`, l'app ne doit rien savoir du
 * decoupage en services (contrainte 5 de architecture-microservices.md).
 *
 * `cursor` est opaque et **pas** un UUID : il encode une position chez la source ou dans l'index
 * local, pas une cle primaire. D'ou la reconstruction du schema plutot que l'extension de
 * `PaginationQuerySchema`.
 */
export const LegoSearchQuerySchema = z
  .object({
    q: z.string().min(1).max(200).optional(),
    // EAN-13 / UPC-A. Le scanner rend des chiffres nus ; la normalisation (espaces, tirets,
    // equivalence UPC/EAN) a lieu dans `barcode.ts`, pas ici.
    barcode: z
      .string()
      .regex(/^[0-9\s-]{6,20}$/, 'barcode must be 6-20 digits')
      .optional(),
    // Type de set : "technic", "architecture", "city"... Resolu vers un theme Rebrickable
    // et sa descendance par `ThemeSyncService`.
    theme: z.string().min(1).max(64).optional(),
    type: z.literal('lego'),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine((d) => Boolean(d.q || d.barcode || d.theme), {
    message: 'at least one of `q`, `barcode` or `theme` is required',
    path: ['q'],
  })
  .refine((d) => !(d.barcode && (d.q || d.theme)), {
    // Un code-barres designe UNE boite : le croiser avec un nom ou un theme n'a pas de sens
    // et masquerait une erreur d'appel plutot que de la signaler.
    message: '`barcode` cannot be combined with `q` or `theme`',
    path: ['barcode'],
  });

export class LegoSearchQueryDto extends createZodDto(LegoSearchQuerySchema) {}
