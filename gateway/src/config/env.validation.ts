import { z } from 'zod';

/**
 * Configuration du gateway.
 *
 * Le gateway est le seul service a connaitre l'adresse de tous les autres : c'est ce qui
 * fait de lui le point d'entree, et c'est aussi ce qui interdit a deux services de se
 * decouvrir par hasard. Une URL absente n'est pas une erreur de boot - le service
 * correspondant est simplement declare injoignable et ses routes repondent 503. Demarrer
 * une constellation incomplete doit rester possible : c'est le mode de travail normal
 * quand on developpe un seul service.
 */
export const EnvSchema = z.object({
  PORT: z.coerce.number().int().default(3100),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().default(6379),

  // Le gateway VERIFIE les JWT emis par `identity` ; il n'en signe aucun. Pas de cle
  // privee ici, c'est volontaire : la seule autorite d'emission est `identity`.
  JWT_PUBLIC_KEY: z.string().min(1),

  // Secret HMAC du principal signe (3.6). Obligatoire ici, contrairement aux services
  // aval ou il est optionnel : le gateway est celui qui SIGNE. Sans lui, il n'a aucun
  // moyen de transmettre une identite resolue, et toute la chaine retombe sur une
  // re-verification JWT par service - exactement ce que 3.6 supprime.
  INTERNAL_PRINCIPAL_SECRET: z.string().min(32),
  // Duree de vie du principal, en secondes. Court : il est re-emis a chaque requete, et
  // sa seule raison de vivre est la traversee du reseau interne.
  INTERNAL_PRINCIPAL_TTL: z.coerce.number().int().min(10).max(3600).default(120),

  // Secret des appels /internal/* sortants (registre, premium, acces).
  INTERNAL_SERVICE_TOKEN: z.string().min(16),
  ADMIN_API_TOKEN: z.string().min(16),

  // TTL du cache Redis du statut premium, en secondes (3.6). 60 s par defaut : la fenetre
  // pendant laquelle une perte de premium n'est pas encore effective est assumee - la
  // perte de premium *suspend* les partages, elle ne detruit rien.
  PREMIUM_CACHE_TTL: z.coerce.number().int().min(0).max(600).default(60),

  // --- Adresses des services. Toutes optionnelles : voir le commentaire de tete. -------
  IDENTITY_BASE_URL: z.string().url().optional(),
  BILLING_BASE_URL: z.string().url().optional(),
  CONNECTIONS_BASE_URL: z.string().url().optional(),
  SHARING_BASE_URL: z.string().url().optional(),
  SEARCH_BASE_URL: z.string().url().optional(),
  CATALOG_GENERIC_BASE_URL: z.string().url().optional(),
  CATALOG_MANGA_BASE_URL: z.string().url().optional(),
  CATALOG_VINYL_BASE_URL: z.string().url().optional(),
  CATALOG_LEGO_BASE_URL: z.string().url().optional(),

  // Budget de temps d'un appel proxifie. Plus genereux que les 2 s des appels /internal/* :
  // celui-ci porte une requete utilisateur complete, y compris une recherche externe qui
  // sollicite une file BullMQ.
  PROXY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),

  CORS_ORIGINS: z.string().optional(),
  HTTP_USER_AGENT: z
    .string()
    .min(1)
    .default('Acervatim-Gateway/0.1 (+contact@acervatim.local)'),
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
