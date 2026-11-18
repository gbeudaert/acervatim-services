/**
 * Suite d'integration de `sharing`, contre une vraie base MariaDB (`acv_sharing_it`).
 *
 * Lancement : `npm run test:int` dans le service, ou `./scripts/dev.ps1 test-int sharing`
 * depuis la racine de la constellation.
 */
module.exports = {
  rootDir: '..',
  roots: ['<rootDir>/test'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: 'test/.*\.int-spec\.ts$',
  transform: { '^.+\.ts$': 'ts-jest' },
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/setup-env.js'],
  globalSetup: '<rootDir>/test/global-setup.js',
  testTimeout: 30000,
};
