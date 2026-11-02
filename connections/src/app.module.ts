import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ApiCacheModule } from './common/cache/api-cache.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { GuardsModule } from './common/guards/guards.module';
import { HttpModule } from './common/http/http.module';
import { InternalModule } from './common/internal/internal.module';
import { AccessLogMiddleware } from './common/logging/access-log.middleware';
import { validateEnv } from './config/env.validation';
import { InternalRoutesModule } from './internal/internal.module';
import { OauthModule } from './oauth/oauth.module';
import { PrismaModule } from './prisma/prisma.module';
import { SourcesModule } from './sources/sources.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 200 }],
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    // Purge des flux OAuth en attente expires (cf. `PendingCleanupService`).
    ScheduleModule.forRoot(),
    PrismaModule,
    CryptoModule,
    HttpModule,
    GuardsModule,
    InternalModule,
    ApiCacheModule,
    OauthModule,
    SourcesModule,
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
