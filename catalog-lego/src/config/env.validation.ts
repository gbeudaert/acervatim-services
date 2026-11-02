import { z } from 'zod';

const base64Length = (decodedBytes: number) =>
  z.string().refine((s) => Buffer.from(s, 'base64').length === decodedBytes, {
    message: `must be base64 of exactly ${decodedBytes} bytes`,
  });

export const EnvSchema = z.object({
  // 3010 par defaut : le monolithe occupe 3000 sur le meme hote en dev.
  PORT: z.coerce.number().int().default(3010),
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().default(6379),

  // Ce service ne signe aucun JWT : il ne fait que verifier ceux emis par `identity`
  // (aujourd'hui le monolithe). Pas de cle privee ici, c'est volontaire.
  JWT_PUBLIC_KEY: z.string().min(1),

  // Secret du principal signe pose par le gateway (cf. architecture-microservices.md 3.6).
  // Optionnel tant que le gateway n'existe pas : sans lui, seul le JWT est accepte.
  INTERNAL_PRINCIPAL_SECRET: z.string().min(32).optional(),

  // Chiffrement des cles API personnelles (BYOT). Meme primitive que le monolithe.
  ENCRYPTION_KEY: base64Length(32),

  ADMIN_API_TOKEN: z.string().min(16),

  // Rebrickable - source nominale du catalogue. Cle serveur = repli premium ;
  // chaque utilisateur peut fournir la sienne (compte Rebrickable gratuit).
  REBRICKABLE_API_KEY: z.string().optional(),
  REBRICKABLE_BASE_URL: z
    .string()
    .url()
    .default('https://rebrickable.com/api/v3'),

  // Brickset - source des codes-barres uniquement, consommee hors ligne par le
  // moissonneur. Voir BRICKSET_DAILY_CALL_BUDGET : le quota d'une cle libre est de
  // 100 appels `getSets` par jour, ce qui interdit tout appel sur le chemin chaud.
  BRICKSET_API_KEY: z.string().optional(),
  BRICKSET_BASE_URL: z
    .string()
    .url()
    .default('https://brickset.com/api/v3.asmx'),
  BRICKSET_DAILY_CALL_BUDGET: z.coerce.number().int().min(1).default(90),
  BRICKSET_PAGE_SIZE: z.coerce.number().int().min(1).max(500).default(500),

  CORS_ORIGINS: z.string().optional(),
  HTTP_USER_AGENT: z
    .string()
    .min(1)
    .default('Acervatim-Lego/0.1 (+contact@acervatim.local)'),
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
