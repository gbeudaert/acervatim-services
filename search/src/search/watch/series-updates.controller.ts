import { Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentPrincipal } from '../../common/decorators/current-principal.decorator';
import { PaymentRequiredException } from '../../common/errors';
import { AdminGuard } from '../../common/guards/admin.guard';
import { PrincipalGuard } from '../../common/guards/principal.guard';
import { Principal } from '../../common/guards/principal.types';
import { EditionWatchService } from './edition-watch.service';
import { SeriesUpdatesResponse } from './edition-watch.types';

/**
 * Rattrapage des séries en cours (SD3), côté lecture. Les gardes sont posées **par route** : la
 * route utilisateur exige un principal, la route admin un jeton admin — une garde de classe
 * bloquerait l'appel admin, qui n'a pas d'utilisateur.
 */
@ApiTags('series-updates')
@Controller()
export class SeriesUpdatesController {
  constructor(private readonly watch: EditionWatchService) {}

  /**
   * Tomes parus depuis l'import, par série de l'utilisateur, qu'il n'a pas encore. Réservé au
   * premium comme les routes de synchro : sans synchro, le serveur ne connaît ni ses séries ni ses
   * tomes. Lecture seule — l'app propose, l'utilisateur confirme, la synchro crée les items.
   *
   * Le gateway refuse déjà le non-premium (`premium: 'requester'`) ; le contrôle ici couvre l'appel
   * qui ne passe pas par lui. En mode autonome (JWT seul), le premium n'est pas résoluble et vaut
   * `false` : la route répond 402, comme le monolithe à un compte non premium.
   */
  @Get('series-updates')
  @ApiBearerAuth()
  @UseGuards(PrincipalGuard)
  async list(
    @CurrentPrincipal() principal: Principal,
  ): Promise<SeriesUpdatesResponse> {
    if (!principal.premium) {
      throw new PaymentRequiredException();
    }
    return this.watch.seriesUpdates(principal.userId);
  }

  /** Déclenche un passage de rattrapage hors planification (test, rattrapage d'un incident). */
  @Post('admin/edition-watch/run')
  @HttpCode(202)
  @UseGuards(AdminGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async run(): Promise<{ jobId: string }> {
    return this.watch.enqueueManualRun();
  }
}
