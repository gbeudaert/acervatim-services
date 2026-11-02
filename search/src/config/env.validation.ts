import { z } from 'zod';

/**
 * Configuration du service search.
 *
 * Il porte les **cles serveur Acervatim** des sources externes - celles du repli premium.
 * `connections` porte celles des utilisateurs, et la resolution de jeton ne transmet jamais
 * l'une pour l'autre : elle rend une decision (`user` / `fallback` / `none`), et chaque
 * service utilise ses propres secrets.
 *
 * Toutes optionnelles : une source non configuree degrade en mode cache puis repond
 * `403 source-token-required`, ce qui est le comportement nominal du monolithe pour un
 * utilisateur ni connecte ni premium.
 */
export const EnvSchema = z.object({
  PORT: z.coerce.number().int().default(3150),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url(),
  // Redis : backing store des six files BullMQ (debit sortant borne + single-flight).
  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().default(6379),

  JWT_PUBLIC_KEY: z.string().min(1),
  INTERNAL_PRINCIPAL_SECRET: z.string().min(32).optional(),
  INTERNAL_SERVICE_TOKEN: z.string().min(16),
  ADMIN_API_TOKEN: z.string().min(16),

  /**
   * Resolution des jetons personnels - elle vit dans `connections`. Absente ou injoignable,
   * toutes les sources retombent en mode degrade (cache) : c'est le seul repli sur, supposer
   * un droit qu'on ne sait pas verifier consommerait la cle serveur pour rien.
   */
  CONNECTIONS_BASE_URL: z.string().url().optional(),
  /** Journal d'audit - il vit dans `identity`. */
  IDENTITY_BASE_URL: z.string().url().optional(),

  // --- Cles serveur des sources (repli premium) -------------------------------
  DISCOGS_CONSUMER_KEY: z.string().optional(),
  DISCOGS_CONSUMER_SECRET: z.string().optional(),
  // Personal access token d'un compte Discogs Acervatim : 60 req/min ET les images. La
  // signature consumer-seule authentifie mais ne renvoie pas les jaquettes - d'ou ce jeton
  // en plus du consumer, et non a sa place.
  DISCOGS_ACERVATIM_TOKEN: z.string().optional(),
  // Meme valeur que dans `connections`, autre role : la-bas c'est l'identifiant du flux
  // d'autorisation, ici la cle du repli premium (`X-MAL-CLIENT-ID`, donnees publiques).
  MAL_CLIENT_ID: z.string().optional(),
  TMDB_API_KEY: z.string().optional(),
  // Google Books - resolveur de jaquette par ISBN. Quota reduit sans cle, pas nul.
  GOOGLE_BOOKS_API_KEY: z.string().optional(),
  // Catalogue general BnF (SRU) - enumeration d'edition et pivot ISBN -> titre original.
  BNF_SRU_BASE_URL: z.string().url().default('https://catalogue.bnf.fr/api/SRU'),

  CORS_ORIGINS: z.string().optional(),
  HTTP_USER_AGENT: z
    .string()
    .min(1)
    .default('Acervatim-Search/0.1 (+contact@acervatim.local)'),
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
