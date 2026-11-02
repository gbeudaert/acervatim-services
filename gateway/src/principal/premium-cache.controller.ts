import {
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { InternalGuard } from '../common/guards/internal.guard';
import { PremiumCacheService } from './premium-cache.service';

/**
 * Invalidation du cache premium par `billing` (3.6).
 *
 * Le TTL de 60 s est un compromis assume dans un seul sens : une perte de premium peut
 * mettre jusqu'a une minute a produire effet, ce qui est sans consequence puisqu'elle
 * *suspend* les partages sans rien detruire. Dans l'autre sens il ne l'est pas - un
 * utilisateur qui vient de payer, ou de consommer une invitation, ne doit pas se voir
 * refuser ses propres collections pendant une minute. D'ou cette route, appelee par
 * `billing` apres toute operation qui accorde un droit.
 *
 * Elle reste **best-effort** cote appelant : si le gateway ne repond pas, l'achat est
 * enregistre quand meme et le TTL fera le travail avec du retard.
 */
@ApiExcludeController()
@Controller('internal/premium-cache')
export class PremiumCacheController {
  constructor(private readonly cache: PremiumCacheService) {}

  @Delete(':userId')
  @UseGuards(InternalGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async invalidate(@Param('userId') userId: string): Promise<void> {
    await this.cache.invalidate(userId);
  }
}
