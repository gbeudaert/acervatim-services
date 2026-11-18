const { integrationDatabaseUrl } = require('./database-url');

/**
 * Environnement de la suite d'integration, pose avant le chargement de chaque fichier de test
 * (`setupFiles`) : `AppModule` valide l'environnement des son import.
 *
 * Tout ce qui designe un voisin pointe vers une adresse `.test` qui n'existe pas : le client
 * interne est remplace par un faux (harness.ts), et un appel qui lui echapperait echouerait
 * franchement au lieu d'atteindre un vrai service. Les secrets sont des valeurs de test, et
 * jamais ceux du conteneur.
 */
process.env.DATABASE_URL = integrationDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.INTERNAL_PRINCIPAL_SECRET =
  'secret-de-test-du-principal-signe-0123456789';
process.env.INTERNAL_SERVICE_TOKEN = 'jeton-interne-de-test-0123456789';
process.env.ADMIN_API_TOKEN = 'jeton-admin-de-test-0123456789';
process.env.SHARE_CODE_PEPPER = 'pepper-de-test-des-codes-de-partage-0123';
process.env.JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY || 'inutilise-en-test';
process.env.IDENTITY_BASE_URL = 'http://identity.test';
process.env.BILLING_BASE_URL = 'http://billing.test';
process.env.CATALOG_GENERIC_BASE_URL = 'http://catalog-generic.test';
process.env.CATALOG_MANGA_BASE_URL = 'http://catalog-manga.test';
process.env.CATALOG_VINYL_BASE_URL = 'http://catalog-vinyl.test';
process.env.CATALOG_LEGO_BASE_URL = 'http://catalog-lego.test';
