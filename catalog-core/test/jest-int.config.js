/**
 * Suite d'integration de `catalog-core`, contre une vraie base MariaDB.
 *
 * Elle ne tourne pas seule : comme le reste de la bibliotheque, elle est compilee dans un
 * catalog, contre le client Prisma que celui-ci a genere. `rootDir` est donc la racine du
 * catalog (`/app` dans le conteneur), et la base est celle du catalog suffixee `_it`
 * (database-url.js). Lancement : `npm run test:int` dans un catalog, ou
 * `./scripts/dev.ps1 test-int <catalog>` depuis la racine de la constellation.
 */
module.exports = {
  rootDir: '../..',
  // Dans le conteneur de dev, `/app/catalog-core` est un lien symbolique (la jonction de
  // `link-core`, montee) : Jest ne suit pas les liens en cherchant les tests, il faut lui
  // donner le dossier. `modulePaths` resout les dependances depuis le catalog, pour la meme
  // raison.
  roots: ['<rootDir>/catalog-core/test'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: 'catalog-core/test/.*\\.int-spec\\.ts$',
  transform: { '^.+\\.ts$': 'ts-jest' },
  testEnvironment: 'node',
  modulePaths: ['<rootDir>/node_modules'],
  globalSetup: '<rootDir>/catalog-core/test/global-setup.js',
  testTimeout: 30000,
};
