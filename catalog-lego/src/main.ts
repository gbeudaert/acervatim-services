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
import { AppModule } from './app.module';
import { ProblemDetailsExceptionFilter } from './common/filters/problem-details.filter';
import { CorrelationIdInterceptor } from './common/interceptors/correlation-id.interceptor';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);

  // Un seul saut de proxy de confiance, pour que `req.ip` reflete le client reel et que le
  // throttler compte par utilisateur et non par proxy. Vaut derriere le reverse proxy comme
  // derriere le gateway.
  app.set('trust proxy', 1);

  app.use(helmet({ contentSecurityPolicy: false }));
  // 64 ko : ce service ne recoit que des query strings et un jeton API. Aucune raison
  // d'accepter les 256 ko du monolithe, qui lui recoit des `unifiedData`.
  app.use(json({ limit: '64kb' }));

  const corsOrigins = (config.get<string>('CORS_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-Request-Id',
      'X-Acervatim-Principal',
    ],
    maxAge: 600,
  });

  // Meme prefixe `/v1` que le monolithe : derriere le gateway, ce service doit repondre a
  // l'URL que l'app connait deja. `/health/*` et `/internal/*` restent hors versioning -
  // le premier est de l'infra, le second un contrat entre services, pas une API publique.
  app.setGlobalPrefix('v1', {
    exclude: [
      { path: 'health', method: RequestMethod.ALL },
      { path: 'health/(.*)', method: RequestMethod.ALL },
      { path: 'internal/(.*)', method: RequestMethod.ALL },
      { path: 'admin/(.*)', method: RequestMethod.ALL },
    ],
  });

  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalInterceptors(new CorrelationIdInterceptor());
  app.useGlobalFilters(new ProblemDetailsExceptionFilter());

  patchNestJsSwagger();
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Acervatim LEGO API')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  writeFileSync('./openapi.json', JSON.stringify(document, null, 2));
  if (process.env.NODE_ENV !== 'production') {
    SwaggerModule.setup('docs', app, document);
  }

  // Draine les workers BullMQ au SIGTERM : sans ca, un moissonnage en cours est perdu
  // au lieu d'etre repris a son dernier point de reprise.
  app.enableShutdownHooks();

  const port = config.get<number>('PORT', 3010);
  await app.listen(port);

  const pkg = JSON.parse(
    readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
  ) as { name: string; version: string };
  new Logger('Bootstrap').log(
    `${pkg.name} v${pkg.version} demarre - port=${port} env=${process.env.NODE_ENV ?? 'development'}`,
  );
}

bootstrap();
