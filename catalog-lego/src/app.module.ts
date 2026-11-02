import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ApiCacheModule } from './common/cache/api-cache.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { GuardsModule } from './common/guards/guards.module';
import { HttpModule } from './common/http/http.module';
import { AccessLogMiddleware } from './common/logging/access-log.middleware';
import { RedisHealthModule } from './common/redis/redis-health.module';
import { BricksetModule } from './common/sources/brickset/brickset.module';
import { RebrickableModule } from './common/sources/rebrickable/rebrickable.module';
import { SetIndexModule } from './common/sources/set-index/set-index.module';
import { SourcesModule } from './common/sources/sources.module';
import { validateEnv } from './config/env.validation';
import { InternalModule } from './internal/internal.module';
import { PrismaModule } from './prisma/prisma.module';
import { SearchModule } from './search/search.module';
import { SourcesApiModule } from './sources/sources-api.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    // Un seul bucket global, comme dans le monolithe : avec @nestjs/throttler v6, tout
    // throttler nomme ici s'applique a TOUTES les routes. Les routes d'exploitation
    // s'excluent par `@SkipThrottle`, pas par un second bucket.
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 100 }],
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    ScheduleModule.forRoot(),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
        },
      }),
    }),
    CryptoModule,
    PrismaModule,
    HttpModule,
    GuardsModule,
    ApiCacheModule,
    RedisHealthModule,
    SourcesModule,
    RebrickableModule,
    BricksetModule,
    SetIndexModule,
    SearchModule,
    SourcesApiModule,
    AdminModule,
    InternalModule,
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
  }
}
