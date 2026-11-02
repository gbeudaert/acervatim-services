import { z } from 'zod';

/**
 * Configuration du service identity.
 *
 * C'est le seul service qui detienne `JWT_PRIVATE_KEY` : il est la seule autorite
 * d'emission de jetons de la constellation. Tous les autres n'ont que la cle publique, et
 * le gateway est meme le seul a s'en servir (3.6).
 */
export const EnvSchema = z.object({
  PORT: z.coerce.number().int().default(3110),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url(),

  // Paire RSA du JWT interne. La privee ne sort jamais d'ici.
  JWT_PRIVATE_KEY: z.string().min(1),
  JWT_PUBLIC_KEY: z.string().min(1),

  // Audience des id_token Google echanges par POST /v1/auth/google.
  GOOGLE_CLIENT_ID: z.string().min(1),

  // Pepper du pivot d'identite. Sa rotation invaliderait tous les comptes : c'est le
  // secret le plus critique du systeme, et il n'a de sens que dans ce service.
  SUB_HASH_PEPPER: z.string().min(32),

  // Principal signe pose par le gateway (3.6). Optionnel : sans lui, ce service verifie
  // lui-meme le JWT - mode autonome, utile quand on developpe identity seul.
  INTERNAL_PRINCIPAL_SECRET: z.string().min(32).optional(),

  INTERNAL_SERVICE_TOKEN: z.string().min(16),
  ADMIN_API_TOKEN: z.string().min(16),

  /**
   * Participants de la saga RGPD, sous la forme `nom=url,nom=url`.
   *
   * Declares par configuration et non en dur : le phasage (4) fait apparaitre les services
   * un par un, et une liste codee dans le source rendrait chaque palier dependant d'un
   * deploiement d'identity. Un participant absent de cette liste ne recoit **jamais** de
   * demande de suppression - c'est donc la ligne a completer en meme temps qu'on ajoute un
   * service qui detient des donnees utilisateur.
   */
  SAGA_PARTICIPANTS: z.string().default(''),

  /** Age au-dela duquel un job de suppression non termine devient une alerte, en heures. */
  SAGA_ALERT_AFTER_HOURS: z.coerce.number().int().min(1).default(24),

  /**
   * Adresse de `billing`, pour le seul `GET /v1/me` : le contrat V1 y expose la source et
   * l'echeance du premium, pas seulement le booleen que porte le principal signe.
   * Optionnelle - sans elle, `/v1/me` rend `premium: false` plutot que d'echouer.
   */
  BILLING_BASE_URL: z.string().url().optional(),

  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().default(6379),
  CORS_ORIGINS: z.string().optional(),
  HTTP_USER_AGENT: z
    .string()
    .min(1)
    .default('Acervatim-Identity/0.1 (+contact@acervatim.local)'),
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
