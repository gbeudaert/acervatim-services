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
import { AuthModule } from './auth/auth.module';
import { AuditLogModule } from './common/audit/audit-log.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { GuardsModule } from './common/guards/guards.module';
import { InternalModule } from './common/internal/internal.module';
import { AccessLogMiddleware } from './common/logging/access-log.middleware';
import { validateEnv } from './config/env.validation';
import { InternalRoutesModule } from './internal/internal.module';
import { PrismaModule } from './prisma/prisma.module';
import { SagaModule } from './saga/saga.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    // Filet de securite, pas la limitation principale : celle-ci est portee par le gateway,
    // qui voit tout le trafic. Ce bucket protege le service d'un appel direct depuis le
    // reseau interne, cas qui ne devrait pas se produire mais qui ne doit pas etre libre.
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 200 }],
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    // Rejeu de la saga RGPD toutes les 15 minutes.
    ScheduleModule.forRoot(),
    PrismaModule,
    CryptoModule,
    GuardsModule,
    InternalModule,
    AuditLogModule,
    SagaModule,
    AuthModule,
    UsersModule,
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
