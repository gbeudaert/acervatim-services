import { Controller, Get, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Response } from 'express';
import { AppService } from './app.service';
import { readinessHttpStatus } from './common/health/readiness';

@ApiExcludeController()
@Controller()
export class AppController {
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
}
