import { z } from 'zod';

const base64Length = (decodedBytes: number) =>
  z.string().refine((s) => Buffer.from(s, 'base64').length === decodedBytes, {
    message: `must be base64 of exactly ${decodedBytes} bytes`,
  });

/**
 * Configuration du service connections.
 *
 * Il detient les secrets **applicatifs** des flux OAuth (consumer Discogs, client MAL) et la
 * cle qui chiffre les secrets **des utilisateurs**. Il ne detient PAS les cles serveur de
 * consommation (`TMDB_API_KEY`, `DISCOGS_ACERVATIM_TOKEN`, ...) : celles-ci appartiennent au
 * service qui appelle la source, c'est-a-dire `search`. La resolution de jeton ne rend
 * qu'une decision, jamais une cle serveur.
 */
export const EnvSchema = z.object({
  PORT: z.coerce.number().int().default(3130),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().default(6379),

  JWT_PUBLIC_KEY: z.string().min(1),
  INTERNAL_PRINCIPAL_SECRET: z.string().min(32).optional(),
  INTERNAL_SERVICE_TOKEN: z.string().min(16),
  ADMIN_API_TOKEN: z.string().min(16),

  // Chiffrement AES-256-GCM des jetons utilisateurs. **Obligatoire ici**, contrairement aux
  // autres services : c'est le seul qui chiffre quoi que ce soit, et demarrer sans cette cle
  // reviendrait a accepter des connexions qu'on ne saura pas stocker.
  ENCRYPTION_KEY: base64Length(32),

  /** Journal d'audit - il vit dans `identity`. */
  IDENTITY_BASE_URL: z.string().url().optional(),
  /**
   * Statut premium - il vit dans `billing`. Absent ou injoignable, la resolution de jeton
   * retombe sur `none` : accorder un repli premium qu'on ne sait pas verifier consommerait
   * la cle serveur Acervatim pour un utilisateur peut-etre gratuit.
   */
  BILLING_BASE_URL: z.string().url().optional(),

  // --- Discogs (OAuth 1.0a) ---------------------------------------------------
  DISCOGS_CONSUMER_KEY: z.string().optional(),
  DISCOGS_CONSUMER_SECRET: z.string().optional(),
  // Le callback pointe le **gateway**, pas ce service : c'est l'URL que Discogs affichera
  // et vers laquelle le navigateur reviendra.
  DISCOGS_CALLBACK_URL: z
    .string()
    .url()
    .default('http://localhost:3100/v1/oauth/discogs/callback'),

  // --- MyAnimeList (OAuth 2.0 + PKCE plain) -----------------------------------
  MAL_CLIENT_ID: z.string().optional(),
  MAL_CLIENT_SECRET: z.string().optional(),
  MAL_CALLBACK_URL: z
    .string()
    .url()
    .default('http://localhost:3100/v1/oauth/mal/callback'),

  CORS_ORIGINS: z.string().optional(),
  HTTP_USER_AGENT: z
    .string()
    .min(1)
    .default('Acervatim-Connections/0.1 (+contact@acervatim.local)'),
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
