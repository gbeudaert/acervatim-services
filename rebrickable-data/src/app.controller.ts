import { Controller, Get } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { AppService } from './app.service';

@ApiExcludeController()
@Controller()
export class AppController {
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
}
