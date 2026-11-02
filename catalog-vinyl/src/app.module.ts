import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import {
  CATALOG_CONFIG,
  CATALOG_INTERNAL_CONTROLLERS,
  CATALOG_PUBLIC_CONTROLLERS,
  CatalogConfig,
  CatalogCoreModule,
} from '../catalog-core/src';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { GuardsModule } from './common/guards/guards.module';
import { InternalTokenMiddleware } from './common/guards/internal-token.middleware';
import { PrincipalMiddleware } from './common/guards/principal.middleware';
import { InternalClientService } from './common/internal/internal-client.service';
import { InternalModule } from './common/internal/internal.module';
import { AccessLogMiddleware } from './common/logging/access-log.middleware';
import { validateEnv } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';
import { PROFILES } from './profiles';

/**
 * catalog-vinyl - un service catalog se reduit a trois choses : son schema, son socle technique, et
 * la declaration de ses profils de type.
 *
 * Tout le CRUD vient de `@acervatim/catalog-core`. Le recopier ici creerait exactement la
 * divergence que le decoupage cherche a eviter (2 de architecture-microservices.md).
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    // Filet de securite contre un appel direct depuis le reseau interne : la limitation
    // principale est portee par le gateway, qui voit tout le trafic.
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 200 }],
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    PrismaModule,
    GuardsModule,
    InternalModule,
    CatalogCoreModule.register({
      profiles: PROFILES,
      db: PrismaService,
      internalTransport: InternalClientService,
      configFactory: {
        provide: CATALOG_CONFIG,
        inject: [ConfigService],
        useFactory: (config: ConfigService): CatalogConfig => ({
          gatewayBaseUrl: config.get<string>('GATEWAY_BASE_URL'),
          searchBaseUrl: config.get<string>('SEARCH_BASE_URL'),
        }),
      },
    }),
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(AccessLogMiddleware)
      .exclude(
        { path: 'health', method: RequestMethod.ALL },
        { path: 'health/(.*)', method: RequestMethod.ALL },
      )
      .forRoutes('*');

    // Identite du requerant sur les routes publiques. Middleware et non garde : les
    // controleurs du domaine viennent de `catalog-core`, et un garde global toucherait aussi
    // `/health/*` et `/internal/*`, qui n'ont pas d'identite a etablir.
    //
    // Accroche aux controleurs, pas a un motif de chemin : voir CATALOG_PUBLIC_CONTROLLERS
    // dans `catalog-core` pour les deux motifs qui ne s'appliquaient pas.
    consumer.apply(PrincipalMiddleware).forRoutes(...CATALOG_PUBLIC_CONTROLLERS);

    // Les routes internes viennent de `catalog-core`, qui ne peut pas y poser
    // `InternalGuard` : la protection s'accroche donc a ses controleurs.
    consumer
      .apply(InternalTokenMiddleware)
      .forRoutes(...CATALOG_INTERNAL_CONTROLLERS);
  }
}
