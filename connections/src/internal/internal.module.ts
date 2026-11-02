import { Module } from '@nestjs/common';
import { OauthModule } from '../oauth/oauth.module';
import { InternalController } from './internal.controller';

@Module({
  imports: [OauthModule],
  controllers: [InternalController],
})
export class InternalRoutesModule {}
