import { Controller, Get } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { AppService } from './app.service';

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

  @Get('health/ready')
  ready() {
    return this.appService.ready();
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
