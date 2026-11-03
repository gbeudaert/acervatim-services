import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';
import { readFileSync } from 'fs';
import helmet from 'helmet';
import { join } from 'path';
import { ZodValidationPipe } from 'nestjs-zod';
import { AppModule } from './app.module';
import { ProblemDetailsExceptionFilter } from './common/filters/problem-details.filter';
import { CorrelationIdInterceptor } from './common/interceptors/correlation-id.interceptor';
import { GLOBAL_PREFIX, GLOBAL_PREFIX_EXCLUSIONS } from './http-prefix';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);

  // Pas de `trust proxy` : aucun proxy devant ce service. Il n'est pas derriere le gateway et
  // n'est appele que par ses voisins (`/internal/*`) et par l'exploitation (`/admin/*`) ; faire
  // confiance a `X-Forwarded-For` laisserait l'appelant choisir l'IP inscrite aux journaux.

  app.use(helmet({ contentSecurityPolicy: false }));
  // 64 ko : ce service ne recoit que de petits corps JSON. Aucune raison d'accepter les
  // 256 ko du monolithe, qui portait les `unifiedData` des items.
  app.use(json({ limit: '64kb' }));

  // CORS ferme par defaut : ce service n'est jamais appele par un navigateur. La variable
  // existe pour les cas de diagnostic, pas pour l'exploitation.
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

  // Aucune route sous `/v1` : `/health*`, `/internal/*` et `/admin/*` en sont exclues (cf.
  // `http-prefix.ts`). Pas de `/openapi.json` ni de `/docs` : sans route publique, le document
  // serait vide, et le gateway ne route pas ce service.
  app.setGlobalPrefix(GLOBAL_PREFIX, { exclude: GLOBAL_PREFIX_EXCLUSIONS });

  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalInterceptors(new CorrelationIdInterceptor());
  app.useGlobalFilters(new ProblemDetailsExceptionFilter());

  app.enableShutdownHooks();

  const port = config.get<number>('PORT', 3190);
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
