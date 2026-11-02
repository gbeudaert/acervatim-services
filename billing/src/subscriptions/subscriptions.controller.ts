import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { PrincipalGuard } from '../common/guards/principal.guard';
import { VerifyPurchaseDto } from './dto/verify-purchase.dto';
import { PubsubVerifierService } from './pubsub-verifier.service';
import { SubscriptionsService } from './subscriptions.service';

@ApiTags('subscriptions')
@Controller()
export class SubscriptionsController {
  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly pubsubVerifier: PubsubVerifierService,
  ) {}

  @Post('subscriptions/verify')
  @ApiBearerAuth()
  @UseGuards(PrincipalGuard)
  @HttpCode(HttpStatus.OK)
  async verify(@CurrentUserId() userId: string, @Body() dto: VerifyPurchaseDto) {
    return this.subscriptions.handleVerify(
      userId,
      dto.purchaseToken,
      dto.productId,
    );
  }

  /**
   * Webhook Pub/Sub RTDN - appele par Google, pas par l'app, et **relaye tel quel par le
   * gateway sans principal signe** : Google ne possede pas notre jeton. L'authentification
   * est le JWT OIDC signe par Google que `PubsubVerifierService` verifie.
   *
   * Hors throttler des deux cotes (ici et dans la table de routage du gateway) : un `429`
   * ferait retenter Pub/Sub en boucle, transformant un pic legitime en tempete.
   */
  @Post('webhooks/google-play/rtdn')
  @SkipThrottle()
  @ApiExcludeEndpoint()
  @HttpCode(HttpStatus.OK)
  async rtdn(
    @Headers('authorization') authHeader: string | undefined,
    @Req() req: Request,
  ) {
    await this.pubsubVerifier.verify(authHeader);
    return this.subscriptions.handleRtdn(req.body);
  }
}
