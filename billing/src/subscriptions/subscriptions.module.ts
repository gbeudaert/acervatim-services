import { Module } from '@nestjs/common';
import { PremiumModule } from '../premium/premium.module';
import { GooglePlayService } from './google-play.service';
import { PubsubVerifierService } from './pubsub-verifier.service';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsCronService } from './subscriptions.cron';
import { SubscriptionsService } from './subscriptions.service';

@Module({
  imports: [PremiumModule],
  controllers: [SubscriptionsController],
  providers: [
    SubscriptionsService,
    GooglePlayService,
    PubsubVerifierService,
    SubscriptionsCronService,
  ],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
