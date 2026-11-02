import { Logger, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json } from 'express';
import { readFileSync, writeFileSync } from 'fs';
import helmet from 'helmet';
import { join } from 'path';
import { patchNestJsSwagger, ZodValidationPipe } from 'nestjs-zod';
import { AppController } from './app.controller';
import { AppModule } from './app.module';
import { ProblemDetailsExceptionFilter } from './common/filters/problem-details.filter';
import { CorrelationIdInterceptor } from './common/interceptors/correlation-id.interceptor';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);

  // Un seul saut de proxy de confiance, pour que `req.ip` reflete l'appelant reel dans les
  // journaux. Ce service est derriere le gateway, qui porte la limitation de debit.
  app.set('trust proxy', 1);

  app.use(helmet({ contentSecurityPolicy: false }));
  // 256 ko, comme le monolithe : ce service recoit des `unifiedData`, et resserrer ici
  // refuserait des corps que le contrat V1 accepte aujourd'hui.
  app.use(json({ limit: '256kb' }));

  // CORS ferme par defaut : ce service n'est jamais appele par un navigateur, seulement par
  // le gateway. La variable existe pour les cas de diagnostic, pas pour l'exploitation.
  const corsOrigins = (config.get<string>('CORS_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-Request-Id',
      'X-Acervatim-Principal',
    ],
    maxAge: 600,
  });

  // Meme prefixe `/v1` que le monolithe : derriere le gateway, ce service doit repondre a
  // l'URL que l'app connait deja. `/health/*` et `/internal/*` restent hors versioning - le
  // premier est de l'infra, le second un contrat entre services, pas une API publique.
  app.setGlobalPrefix('v1', {
    exclude: [
      { path: 'health', method: RequestMethod.ALL },
      { path: 'health/(.*)', method: RequestMethod.ALL },
      { path: 'internal/(.*)', method: RequestMethod.ALL },
      { path: 'openapi.json', method: RequestMethod.ALL },
    ],
  });

  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalInterceptors(new CorrelationIdInterceptor());
  app.useGlobalFilters(new ProblemDetailsExceptionFilter());

  patchNestJsSwagger();
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Acervatim Catalog (manga) API')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  AppController.openApiDocument = document as unknown as Record<string, unknown>;
  if (process.env.NODE_ENV !== 'production') {
    // Artefact de developpement, ignore par git. **Hors production** : le document est servi
    // en memoire sur `/openapi.json` (c'est par la que le gateway l'agrege), et ecrire un
    // fichier a chaque demarrage obligerait le conteneur a garder son systeme de fichiers
    // inscriptible pour rien.
    writeFileSync('./openapi.json', JSON.stringify(document, null, 2));
    SwaggerModule.setup('docs', app, document);
  }

  app.enableShutdownHooks();

  const port = config.get<number>('PORT', 3170);
  await app.listen(port);

  // Resolu depuis le repertoire de travail, pas depuis `__dirname` : la disposition de
  // `dist/` n'est pas la meme partout - `dist/main.js` ici, `dist/src/main.js` pour les
  // catalogs, dont la racine de compilation englobe `catalog-core/`. Le WORKDIR, lui, est
  // toujours celui qui contient `package.json`, en developpement comme dans l'image.
  const pkg = JSON.parse(
    readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
  ) as { name: string; version: string };
  new Logger('Bootstrap').log(
    `${pkg.name} v${pkg.version} demarre - port=${port} env=${process.env.NODE_ENV ?? 'development'}`,
  );
}

bootstrap();
