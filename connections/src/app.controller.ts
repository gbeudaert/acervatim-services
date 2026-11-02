import { Controller, Get } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { AppService } from './app.service';

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

  @Get('health/ready')
  @SkipThrottle()
  ready() {
    return this.appService.ready();
  }

  @Get('openapi.json')
  @SkipThrottle()
  openapi() {
    return AppController.openApiDocument;
  }
}
