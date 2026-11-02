import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Cle API personnelle (BYOT). Aucune validation de format cote serveur : TMDB v3 fait 32
 * caracteres hexadecimaux, mais un read access token v4 est bien plus long, et un autre
 * fournisseur aura encore une autre forme. Une cle invalide echouera au premier appel reel -
 * decision heritee du monolithe : pas de ping a la saisie.
 */
export const SetSourceTokenSchema = z
  .object({
    token: z.string().trim().min(1).max(256),
  })
  .strict();

export class SetSourceTokenDto extends createZodDto(SetSourceTokenSchema) {}
