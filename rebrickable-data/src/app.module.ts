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
import { BricksetModule } from './brickset/brickset.module';
import { CatalogModule } from './catalog/catalog.module';
import { ApiCacheModule } from './common/cache/api-cache.module';
import { GuardsModule } from './common/guards/guards.module';
import { HttpModule } from './common/http/http.module';
import { InternalModule } from './common/internal/internal.module';
import { AccessLogMiddleware } from './common/logging/access-log.middleware';
import { RedisHealthModule } from './common/redis/redis-health.module';
import { validateEnv } from './config/env.validation';
import { ImportModule } from './import/import.module';
import { InternalRoutesModule } from './internal/internal.module';
import { JobsModule } from './jobs/jobs.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 200 }],
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    // Un seul cron : import CSV puis campagne Brickset, 03:00 UTC (cf. `DailyRefreshService`).
    ScheduleModule.forRoot(),
    // BullMQ : backing Redis de la file `brickset` (debit sortant borne). La connexion se
    // reconnecte seule si Redis est indisponible au boot.
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
        },
      }),
    }),
    PrismaModule,
    HttpModule,
    GuardsModule,
    InternalModule,
    ApiCacheModule,
    RedisHealthModule,
    CatalogModule,
    ImportModule,
    BricksetModule,
    AdminModule,
    InternalRoutesModule,
    JobsModule,
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
