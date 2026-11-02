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
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ApiCacheModule } from './common/cache/api-cache.module';
import { GuardsModule } from './common/guards/guards.module';
import { HttpModule } from './common/http/http.module';
import { InternalModule } from './common/internal/internal.module';
import { AccessLogMiddleware } from './common/logging/access-log.middleware';
import { RedisHealthModule } from './common/redis/redis-health.module';
import { validateEnv } from './config/env.validation';
import { InternalRoutesModule } from './internal/internal.module';
import { QueueMetricsModule } from './metrics/queue-metrics.module';
import { PrismaModule } from './prisma/prisma.module';
import { SearchModule } from './search/search.module';
import { SourcesModule } from './sources/sources.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 200 }],
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    ScheduleModule.forRoot(),
    // BullMQ : backing Redis des files sortantes (debit global borne + single-flight). La
    // connexion se reconnecte seule si Redis est indisponible au boot ; les producteurs
    // best-effort (jaquettes) degradent en `null` plutot que d'echouer.
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
    SourcesModule,
    SearchModule,
    QueueMetricsModule,
    InternalRoutesModule,
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
