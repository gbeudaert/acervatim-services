import { Module } from '@nestjs/common';
import { PremiumModule } from '../premium/premium.module';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';

@Module({
  // PremiumModule : l'invalidation du cache du gateway apres un grant.
  imports: [PremiumModule],
  controllers: [InvitationsController],
  providers: [InvitationsService],
  exports: [InvitationsService],
})
export class InvitationsModule {}
