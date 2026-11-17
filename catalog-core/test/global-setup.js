const { execFileSync } = require('child_process');
const path = require('path');
const {
  integrationDatabaseName,
  integrationDatabaseUrl,
} = require('./database-url');

/**
 * Recree la base `<schema du catalog>_it` et y joue les migrations du catalog, une fois par
 * execution de la suite. `migrate reset` part d'une base vide : un test ne depend jamais de ce
 * qu'une execution precedente a laisse.
 */
module.exports = async function globalSetup(_globalConfig, projectConfig) {
  const name = integrationDatabaseName();
  if (!name.endsWith('_it')) {
    throw new Error(`base d'integration inattendue : ${name}`);
  }
  // La racine du catalog, et non `__dirname` : dans le conteneur de dev, ce fichier est vu a
  // travers un lien symbolique, et son chemin reel sort du catalog. Le binaire est appele
  // directement : `npx` irait chercher sur le reseau une autre version de Prisma s'il ne
  // trouvait pas celle du catalog.
  const root = projectConfig.rootDir;
  const prisma = path.join(root, 'node_modules', '.bin', 'prisma');
  // eslint-disable-next-line no-console
  console.log(`\nintegration : base ${name}, migrations du catalog`);
  execFileSync(
    prisma,
    ['migrate', 'reset', '--force', '--skip-seed', '--skip-generate'],
    {
      cwd: root,
      env: { ...process.env, DATABASE_URL: integrationDatabaseUrl() },
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );
};
