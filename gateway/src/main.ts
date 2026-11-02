import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json } from 'express';
import { readFileSync } from 'fs';
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

  // Un seul saut de proxy de confiance, pour que `req.ip` reflete le client reel. Le
  // gateway est le seul service ou cela compte : c'est lui qui compte les requetes par
  // client, et sans ce reglage tout le trafic partagerait le compartiment du reverse proxy.
  app.set('trust proxy', 1);

  app.use(helmet({ contentSecurityPolicy: false }));
  // 256 ko, comme le monolithe : le gateway relaie les `unifiedData` vers les catalogs,
  // et resserrer ici refuserait des corps que le contrat V1 accepte aujourd'hui.
  app.use(json({ limit: '256kb' }));

  const corsOrigins = (config.get<string>('CORS_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
    maxAge: 600,
  });

  // **Pas de `setGlobalPrefix('v1')`.** Contrairement a tous les autres services, le gateway
  // ne declare pas de routes metier : il apparie l'URL complete (`/v1/...`) contre sa table
  // de routage. Un prefixe global la decalerait et rendrait la table fausse.

  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalInterceptors(new CorrelationIdInterceptor());
  app.useGlobalFilters(new ProblemDetailsExceptionFilter());

  patchNestJsSwagger();
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Acervatim API')
    .setDescription(
      "Contrat public V1. Le gateway ne le sert pas lui-meme : il agrege les documents des services derriere lui (GET /openapi.json).",
    )
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  // Le document local ne decrit que l'ossature ; les chemins viennent de l'agregation.
  AppController.baseOpenApi = SwaggerModule.createDocument(
    app,
    swaggerConfig,
  ) as unknown as Record<string, unknown>;

  // Draine proprement au SIGTERM : une reconstruction de registre en cours doit se
  // terminer plutot que d'etre coupee au milieu d'un re-scan.
  app.enableShutdownHooks();

  const port = config.get<number>('PORT', 3100);
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
