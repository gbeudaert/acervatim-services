import { Controller, Get, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Response } from 'express';
import { AppService } from './app.service';
import { readinessHttpStatus } from './common/health/readiness';

/**
 * Routes servies par le gateway lui-meme. Enregistrees **avant** le proxy attrape-tout,
 * sans quoi elles partiraient en aval.
 */
@ApiExcludeController()
@Controller()
export class AppController {
  /** Document de base, injecte au bootstrap : le gateway n'a pas de routes propres a decrire. */
  static baseOpenApi: Record<string, unknown> = {};

  constructor(private readonly appService: AppService) {}

  @Get('health')
  health() {
    return this.appService.health();
  }

  /**
   * Sonde de disponibilite : `503` des qu'une dependance vitale manque, avec le meme corps
   * qu'en `200` pour que la panne reste diagnosticable.
   */
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const report = await this.appService.ready();
    res.status(readinessHttpStatus(report.status));
    return report;
  }

  /**
   * Contrat public agrege. Non mis en cache : il n'est consulte qu'en developpement, et un
   * cache masquerait justement le changement qu'on vient chercher en le consultant.
   */
  @Get('openapi.json')
  async openapi() {
    return this.appService.aggregateOpenApi(AppController.baseOpenApi);
  }
}
