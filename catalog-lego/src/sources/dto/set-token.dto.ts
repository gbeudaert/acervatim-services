import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const SetSourceTokenSchema = z
  .object({
    // Cle API Rebrickable : chaine opaque. On borne la longueur pour ne pas stocker
    // n'importe quoi, sans presumer d'un format que le fournisseur peut changer.
    token: z.string().min(8).max(512),
  })
  .strict();

export class SetSourceTokenDto extends createZodDto(SetSourceTokenSchema) {}
