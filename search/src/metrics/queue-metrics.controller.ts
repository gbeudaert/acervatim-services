import { Controller, Get, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { AdminGuard } from '../common/guards/admin.guard';
import { QueueMetricsService } from './queue-metrics.service';

/**
 * Endpoint d'observabilité des files BullMQ, réservé à l'admin (Bearer `ADMIN_API_TOKEN`). Sert un
 * instantané des compteurs (backlog / débit récent / échecs) pour surveiller la passerelle sortante
 * et calibrer les limiters — cf. {@link QueueMetricsService}.
 */
@Controller('admin')
export class QueueMetricsController {
  constructor(private readonly metrics: QueueMetricsService) {}

  @Get('queues')
  @UseGuards(AdminGuard)
  @SkipThrottle()
  async queues() {
    return {
      queues: await this.metrics.snapshot(),
      // Taux de hit du cache partagé par famille de clés : la mesure de la pression quota
      // d'une recherche texte (peu cachable) face à un code-barres (très cachable) — SD1.
      cache: this.metrics.cacheSnapshot(),
    };
  }
}
