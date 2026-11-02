import { Module } from '@nestjs/common';
import { SagaModule } from '../saga/saga.module';
import { PremiumClientService } from './premium-client.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [SagaModule],
  controllers: [UsersController],
  providers: [UsersService, PremiumClientService],
  exports: [UsersService],
})
export class UsersModule {}
