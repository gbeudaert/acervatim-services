import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { GuardsModule } from './common/guards/guards.module';
import { InternalModule } from './common/internal/internal.module';
import { AccessLogMiddleware } from './common/logging/access-log.middleware';
import { validateEnv } from './config/env.validation';
import { PrincipalModule } from './principal/principal.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProxyModule } from './proxy/proxy.module';
import { RegistryModule } from './registry/registry.module';
import { RoutingModule } from './routing/routing.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    // Pas de `ThrottlerModule` ici, contrairement au monolithe et aux services aval : le
    // gateway sert toutes ses routes par un controleur attrape-tout, ou `@Throttle` et
    // `@SkipThrottle` n'ont plus de handler distinct sur lequel se poser. La limitation de
    // debit - y compris les resserrages auth 10/min et redeem 5/min, et l'exemption du
    // webhook RTDN - est declaree dans `route-table.ts` et appliquee par
    // `RouteThrottleService`.
    ScheduleModule.forRoot(),
    PrismaModule,
    GuardsModule,
    InternalModule,
    RoutingModule,
    RegistryModule,
    PrincipalModule,
    // EN DERNIER : son controleur est un attrape-tout et Nest apparie dans l'ordre
    // d'enregistrement.
    ProxyModule,
  ],
  controllers: [AppController],
  providers: [AppService],
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
