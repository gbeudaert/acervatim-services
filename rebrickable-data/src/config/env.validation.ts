import { z } from 'zod';

/**
 * Configuration du service rebrickable-data.
 *
 * Deux sources, deux regimes :
 *  - les **CSV publics Rebrickable** (`REBRICKABLE_DOWNLOADS_URL`) : sans cle, telecharges au
 *    plus une fois par jour. C'est la seule automatisation que les CGU de Rebrickable
 *    autorisent (5.3) ; aucun appel a l'API Rebrickable ne part d'ici.
 *  - **Brickset** (`BRICKSET_*`) : la seule source gratuite des codes-barres EAN/UPC, sous quota
 *    journalier. Sans cle, le catalogue se construit quand meme, sans codes-barres.
 */
export const EnvSchema = z.object({
  PORT: z.coerce.number().int().default(3190),
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  DATABASE_URL: z.string().url(),
  // Redis : backing store de la file BullMQ `brickset` (debit sortant borne).
  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().default(6379),

  // Socle commun (gardes copies a l'identique de `search`). Ce service n'expose aucune route
  // utilisateur, mais `PrincipalGuard` fait partie du socle et lit ces deux valeurs au boot.
  JWT_PUBLIC_KEY: z.string().min(1),
  INTERNAL_PRINCIPAL_SECRET: z.string().min(32).optional(),
  INTERNAL_SERVICE_TOKEN: z.string().min(16),
  ADMIN_API_TOKEN: z.string().min(16),

  /**
   * Cle Brickset. Absente (ou vide), le moissonnage des codes-barres ne part pas et l'index se
   * construit sans EAN/UPC. **Transition** : tant que `catalog-lego` moissonne encore de son
   * cote, la cle n'est renseignee qu'ici - deux moissonneurs sur une meme cle se partageraient
   * le quota journalier.
   */
  BRICKSET_API_KEY: z.string().optional(),
  BRICKSET_BASE_URL: z
    .string()
    .url()
    .default('https://brickset.com/api/v3.asmx'),
  /** Plafond d'appels `getSets` par jour UTC. 90 sur 100 : la marge absorbe un appel manuel. */
  BRICKSET_DAILY_CALL_BUDGET: z.coerce.number().int().min(1).default(90),

  REBRICKABLE_DOWNLOADS_URL: z
    .string()
    .url()
    .default('https://cdn.rebrickable.com/media/downloads'),

  CORS_ORIGINS: z.string().optional(),
  HTTP_USER_AGENT: z
    .string()
    .min(1)
    .default('Acervatim-RebrickableData/0.1 (+contact@acervatim.local)'),
});

export type Env = z.infer<typeof EnvSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = EnvSchema.safeParse(config);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid env vars:\n${details}`);
  }
  return parsed.data;
}
