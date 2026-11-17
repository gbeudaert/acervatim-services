import { Controller, Get, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Response } from 'express';
import { AppService } from './app.service';
import { readinessHttpStatus } from './common/health/readiness';

@ApiExcludeController()
@Controller()
export class AppController {
  /**
   * Document OpenAPI de ce service, pose au bootstrap. Servi tel quel pour que le gateway
   * puisse agreger un contrat public unique : sans cette route, connaitre `/v1/*` obligerait
   * a consulter huit specifications.
   */
  static openApiDocument: Record<string, unknown> = {};

  constructor(private readonly appService: AppService) {}

  @Get('health')
  @SkipThrottle()
  health() {
    return this.appService.health();
  }

  /**
   * Sonde de disponibilite : `503` des qu'une dependance vitale manque, avec le meme corps
   * qu'en `200` pour que la panne reste diagnosticable.
   */
  @Get('health/ready')
  @SkipThrottle()
  async ready(@Res({ passthrough: true }) res: Response) {
    const report = await this.appService.ready();
    res.status(readinessHttpStatus(report.status));
    return report;
  }

  @Get('openapi.json')
  @SkipThrottle()
  openapi() {
    return AppController.openApiDocument;
  }
}
