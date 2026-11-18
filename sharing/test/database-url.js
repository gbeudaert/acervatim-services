/**
 * Base de la suite d'integration : celle de `sharing`, suffixee `_it` (`acv_sharing_it`).
 *
 * Elle se deduit de `DATABASE_URL` (meme serveur, meme compte) au lieu d'etre configuree a
 * part, et le nom est verifie avant toute ecriture : la suite vide ses tables entre deux tests
 * et recree sa base au demarrage. Une erreur de configuration ne doit jamais pouvoir lui faire
 * viser la base de travail du service.
 *
 * Idempotent : `setup-env.js` remplace `DATABASE_URL` par l'URL d'integration, et peut etre
 * rejoue pour chaque fichier de test.
 */
const SERVICE_DATABASE = 'acv_sharing';
const INTEGRATION_DATABASE = `${SERVICE_DATABASE}_it`;

function integrationDatabaseUrl(env = process.env) {
  const base = env.DATABASE_URL;
  if (!base) {
    throw new Error(
      "DATABASE_URL absent : la suite d'integration derive sa base de celle du service",
    );
  }
  const url = new URL(base);
  const name = url.pathname.replace(/^\//, '');
  if (name === INTEGRATION_DATABASE) return url.toString();
  if (name !== SERVICE_DATABASE) {
    throw new Error(
      `DATABASE_URL vise "${name}" : la suite d'integration ne tourne que depuis sharing (${SERVICE_DATABASE})`,
    );
  }
  url.pathname = `/${INTEGRATION_DATABASE}`;
  return url.toString();
}

module.exports = { integrationDatabaseUrl, INTEGRATION_DATABASE };
