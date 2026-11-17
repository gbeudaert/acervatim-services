/**
 * Base de la suite d'integration : celle du catalog qui l'execute, suffixee `_it`.
 *
 * Elle se deduit de `DATABASE_URL` (meme serveur, meme compte) au lieu d'etre configuree a
 * part, et le suffixe est verifie avant toute ecriture : la suite vide ses tables entre deux
 * tests et recree sa base au demarrage. Une erreur de configuration ne doit jamais pouvoir lui
 * faire viser la base de travail du service.
 */
function integrationDatabaseUrl(env = process.env) {
  const base = env.DATABASE_URL;
  if (!base) {
    throw new Error(
      "DATABASE_URL absent : la suite d'integration derive sa base de celle du service",
    );
  }
  const url = new URL(base);
  const name = url.pathname.replace(/^\//, '');
  if (!/^acv_cat_[a-z]+$/.test(name)) {
    throw new Error(
      `DATABASE_URL vise "${name}" : la suite d'integration ne tourne que depuis un catalog (acv_cat_*)`,
    );
  }
  url.pathname = `/${name}_it`;
  return url.toString();
}

/** Nom de la base, pour le controle de securite avant chaque nettoyage. */
function integrationDatabaseName(env = process.env) {
  return new URL(integrationDatabaseUrl(env)).pathname.replace(/^\//, '');
}

module.exports = { integrationDatabaseUrl, integrationDatabaseName };
