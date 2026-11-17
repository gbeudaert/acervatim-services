import { z } from 'zod';

/**
 * Configuration du service rebrickable-data.
 *
 * Deux sources, deux regimes :
 *  - les **CSV publics Rebrickable** (`REBRICKABLE_DOWNLOADS_URL`) : sans cle, telecharges au
 *    plus une fois par jour. C'est la seule automatisation que les CGU de Rebrickable
 *    autorisent (5.3) ; aucun appel a l'API Rebrickable ne part d'ici.
 *  - **Brickset** (`BRICKSET_*`) : la seule source gratuite des codes-barres EAN/UPC, sous quota
 *    journalier, appelee seulement au scan d'un code absent du cache. Sans cle, le catalogue se
 *    construit quand meme, et le scan ne trouve rien.
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
   * Cle Brickset. Absente (ou vide), aucun appel ne part : le scan ne sert que le cache, vide en
   * pratique. Elle n'est renseignee qu'ici, jamais dans `catalog-lego` : deux services sur une
   * meme cle se partageraient le quota journalier, et chacun croirait disposer de tout.
   */
  BRICKSET_API_KEY: z.string().optional(),
  BRICKSET_BASE_URL: z
    .string()
    .url()
    .default('https://brickset.com/api/v3.asmx'),
  /** Plafond d'appels `getSets` par jour UTC. 90 sur 100 : la marge absorbe un appel manuel. */
  BRICKSET_DAILY_CALL_BUDGET: z.coerce.number().int().min(1).default(90),
  /**
   * Duree de vie d'un code confirme par Brickset. 90 jours au plus : c'est l'engagement du
   * courrier a Brickset. Au-dela, le code n'est plus servi, puis le passage quotidien l'efface.
   */
  BRICKSET_BARCODE_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(90),
  /** Duree pendant laquelle un code inconnu de Brickset n'est pas redemande. */
  BRICKSET_MISS_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  /**
   * Attente maximale de Brickset pendant un scan. Doit rester sous le delai que `search` laisse
   * a cette route, lui-meme sous celui du client mobile.
   */
  BRICKSET_SCAN_WAIT_MS: z.coerce
    .number()
    .int()
    .min(500)
    .max(9000)
    .default(6000),

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
