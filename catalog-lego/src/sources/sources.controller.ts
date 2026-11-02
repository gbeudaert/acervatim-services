import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { PrincipalGuard } from '../common/guards/principal.guard';
import { SetSourceTokenDto } from './dto/set-token.dto';
import { SourcesService } from './sources.service';

/**
 * Gestion des cles API personnelles (BYOT).
 *
 * Rebrickable n'a pas d'OAuth : la cle se recupere sur le compte utilisateur et se colle, comme
 * TMDB dans le monolithe (`PUT /v1/sources/tmdb/token`). On reprend donc la meme forme d'API
 * plutot que d'en inventer une - l'ecran « connecter une source » de l'app n'a rien a apprendre.
 *
 * PROVISOIRE : dans la cible, ces routes appartiennent a `connections`. Elles vivent ici tant
 * que ce service tourne seul (cf. `TokenResolverPort`).
 */
@ApiTags('sources')
@ApiBearerAuth()
@Controller('sources')
@UseGuards(PrincipalGuard)
export class SourcesController {
  constructor(private readonly sources: SourcesService) {}

  @Get()
  async connected(
    @CurrentUserId() userId: string,
  ): Promise<{ data: { provider: string; connectedAt: string }[] }> {
    return { data: await this.sources.listConnected(userId) };
  }

  @Put(':provider/token')
  @HttpCode(204)
  async setToken(
    @CurrentUserId() userId: string,
    @Param('provider') provider: string,
    @Body() body: SetSourceTokenDto,
  ): Promise<void> {
    await this.sources.setToken(
      userId,
      this.sources.assertProvider(provider),
      body.token,
    );
  }

  @Delete(':provider/token')
  @HttpCode(204)
  async revokeToken(
    @CurrentUserId() userId: string,
    @Param('provider') provider: string,
  ): Promise<void> {
    await this.sources.revokeToken(
      userId,
      this.sources.assertProvider(provider),
    );
  }
}
