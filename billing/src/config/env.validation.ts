import { z } from 'zod';

/**
 * Configuration du service billing.
 *
 * Les credentials Google Play sont **optionnels**, comme dans le monolithe : sans eux,
 * `POST /v1/subscriptions/verify` et le webhook RTDN repondent `503`, et les grants
 * manuels continuent de fonctionner. Les rendre obligatoires empecherait de developper
 * tout le reste de la constellation sans un compte Play.
 */
export const EnvSchema = z.object({
  PORT: z.coerce.number().int().default(3120),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url(),

  // Ce service ne signe aucun JWT : il verifie ceux emis par `identity` quand il tourne
  // sans gateway. Pas de cle privee ici, c'est volontaire.
  JWT_PUBLIC_KEY: z.string().min(1),
  INTERNAL_PRINCIPAL_SECRET: z.string().min(32).optional(),
  INTERNAL_SERVICE_TOKEN: z.string().min(16),
  ADMIN_API_TOKEN: z.string().min(16),

  // Pepper des codes d'invitation. Distinct de SHARE_CODE_PEPPER : ces codes-ci sont crees
  // par l'admin seul, leur surface d'exposition et leur cadence de rotation different.
  INVITE_CODE_PEPPER: z.string().min(32),

  /** Journal d'audit - il vit dans `identity`. Absent, les ecritures sont ignorees. */
  IDENTITY_BASE_URL: z.string().url().optional(),
  /**
   * Gateway - pour invalider son cache premium des qu'un droit est accorde. Absent, le TTL
   * de 60 s fait le travail avec du retard, ce qui est acceptable pour une perte de droit
   * mais pas juste apres un paiement.
   */
  GATEWAY_BASE_URL: z.string().url().optional(),

  // --- Google Play Billing ---------------------------------------------------
  GOOGLE_PLAY_PACKAGE_NAME: z.string().min(1).optional(),
  // Le JSON du compte de service est encode en base64 pour eviter les newlines :
  // `private_key` en contient des litterales, qu'un `.env` ne transporte pas intact.
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: z
    .string()
    .min(1)
    .optional()
    .refine(
      (s) => {
        if (!s) return true;
        try {
          const parsed = JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
          return (
            typeof parsed === 'object' &&
            typeof parsed.client_email === 'string' &&
            typeof parsed.private_key === 'string'
          );
        } catch {
          return false;
        }
      },
      { message: 'must be base64-encoded service account JSON' },
    ),
  // Verification du push Pub/Sub. Sans les deux, le webhook refuse tout - echec sur.
  GOOGLE_PUBSUB_SA_EMAIL: z.string().email().optional(),
  GOOGLE_PUBSUB_AUDIENCE: z.string().url().optional(),

  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().default(6379),
  CORS_ORIGINS: z.string().optional(),
  HTTP_USER_AGENT: z
    .string()
    .min(1)
    .default('Acervatim-Billing/0.1 (+contact@acervatim.local)'),
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
