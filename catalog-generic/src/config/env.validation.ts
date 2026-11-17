import { z } from 'zod';

/**
 * Configuration du service catalog-generic.
 *
 * **Identique dans les quatre catalogs**, au port pres : ils ne different que par les profils
 * de type qu'ils servent, pas par ce dont ils ont besoin pour tourner.
 */
export const EnvSchema = z.object({
  PORT: z.coerce.number().int().default(3160),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url(),

  // Ce service ne signe aucun JWT : il verifie ceux emis par `identity` quand il tourne sans
  // gateway. En regime nominal il ne verifie meme pas de JWT - seulement le principal signe.
  JWT_PUBLIC_KEY: z.string().min(1),
  INTERNAL_PRINCIPAL_SECRET: z.string().min(32).optional(),
  INTERNAL_SERVICE_TOKEN: z.string().min(16),
  ADMIN_API_TOKEN: z.string().min(16),

  /**
   * Gateway - pour le registre de routage (3.3). Absent, le service fonctionne mais ses
   * ressources ne sont **pas routables** : c'est le mode autonome, ou l'on tape directement
   * ce catalog.
   */
  GATEWAY_BASE_URL: z.string().url().optional(),
  /**
   * `search` - pour le pre-remplissage d'une source (`POST /internal/sources/snapshot`).
   * Absent, une source attachee est conservee sans enrichissement, exactement comme un
   * provider sans adapter.
   */
  SEARCH_BASE_URL: z.string().url().optional(),
  /** Journal d'audit - il vit dans `identity`. */
  IDENTITY_BASE_URL: z.string().url().optional(),

  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().default(6379),
  CORS_ORIGINS: z.string().optional(),
  HTTP_USER_AGENT: z
    .string()
    .min(1)
    .default('Acervatim-CatalogGeneric/0.1 (+contact@acervatim.local)'),
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
