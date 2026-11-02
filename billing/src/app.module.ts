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
import { CryptoModule } from './common/crypto/crypto.module';
import { GuardsModule } from './common/guards/guards.module';
import { InternalModule } from './common/internal/internal.module';
import { AccessLogMiddleware } from './common/logging/access-log.middleware';
import { validateEnv } from './config/env.validation';
import { InternalRoutesModule } from './internal/internal.module';
import { InvitationsModule } from './invitations/invitations.module';
import { PremiumModule } from './premium/premium.module';
import { PrismaModule } from './prisma/prisma.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    // Filet de securite contre un appel direct depuis le reseau interne : la limitation
    // principale est portee par le gateway, qui voit tout le trafic.
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 200 }],
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    // Cron de re-verification des abonnements qui expirent : le filet si un RTDN se perd.
    ScheduleModule.forRoot(),
    PrismaModule,
    CryptoModule,
    GuardsModule,
    InternalModule,
    PremiumModule,
    SubscriptionsModule,
    InvitationsModule,
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
