const { execFileSync } = require('child_process');
const path = require('path');
const {
  integrationDatabaseUrl,
  INTEGRATION_DATABASE,
} = require('./database-url');

/**
 * Recree la base `acv_sharing_it` et y joue les migrations du service, une fois par execution
 * de la suite. `migrate reset` part d'une base vide : un test ne depend jamais de ce qu'une
 * execution precedente a laisse. Le binaire est appele directement : `npx` irait chercher sur
 * le reseau une autre version de Prisma s'il ne trouvait pas celle du service.
 */
module.exports = async function globalSetup(_globalConfig, projectConfig) {
  const url = integrationDatabaseUrl();
  if (new URL(url).pathname !== `/${INTEGRATION_DATABASE}`) {
    throw new Error(`base d'integration inattendue : ${url}`);
  }
  const root = projectConfig.rootDir;
  const prisma = path.join(root, 'node_modules', '.bin', 'prisma');
  // eslint-disable-next-line no-console
  console.log(
    `\nintegration : base ${INTEGRATION_DATABASE}, migrations de sharing`,
  );
  execFileSync(
    prisma,
    ['migrate', 'reset', '--force', '--skip-seed', '--skip-generate'],
    {
      cwd: root,
      env: { ...process.env, DATABASE_URL: url },
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );
};
