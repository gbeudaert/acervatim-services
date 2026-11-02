import { z } from 'zod';

/**
 * Configuration du service sharing.
 *
 * Il connait l'adresse des catalogs, ce qui peut surprendre : l'invariant du 1 interdit une
 * dependance directe entre deux `apps/`, pas un appel a une route `/internal/*` declaree au
 * contrat. C'est la contrepartie de l'inversion du 3.1 - `sharing` a cesse de LIRE les tables
 * du catalog, il lui DEMANDE. Sans ces URLs, il ne saurait ni verifier une propriete, ni
 * compter ce qu'un membre voit.
 */
export const EnvSchema = z.object({
  PORT: z.coerce.number().int().default(3140),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url(),

  JWT_PUBLIC_KEY: z.string().min(1),
  INTERNAL_PRINCIPAL_SECRET: z.string().min(32).optional(),
  INTERNAL_SERVICE_TOKEN: z.string().min(16),
  ADMIN_API_TOKEN: z.string().min(16),

  // Pepper DEDIE aux codes de partage. Distinct d'INVITE_CODE_PEPPER : ces codes-ci sont
  // generes par n'importe quel utilisateur, pas seulement l'admin - surface d'exposition et
  // cadence de rotation differentes.
  SHARE_CODE_PEPPER: z.string().min(32),

  /** Journal d'audit - il vit dans `identity`. */
  IDENTITY_BASE_URL: z.string().url().optional(),
  /**
   * Statut premium - il vit dans `billing`. Ce service ne s'en sert pas pour autoriser (le
   * gateway le fait en amont) ; la variable reste declaree pour le diagnostic.
   */
  BILLING_BASE_URL: z.string().url().optional(),

  // Catalogs. Un catalog non configure rend ses collections invisibles a la creation de
  // partage (404) et prive ses entrees de compte a la lecture (`itemCount: null`), sans
  // empecher les autres de fonctionner.
  CATALOG_GENERIC_BASE_URL: z.string().url().optional(),
  CATALOG_MANGA_BASE_URL: z.string().url().optional(),
  CATALOG_VINYL_BASE_URL: z.string().url().optional(),

  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().default(6379),
  CORS_ORIGINS: z.string().optional(),
  HTTP_USER_AGENT: z
    .string()
    .min(1)
    .default('Acervatim-Sharing/0.1 (+contact@acervatim.local)'),
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
