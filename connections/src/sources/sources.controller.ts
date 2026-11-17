import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { PrincipalGuard } from '../common/guards/principal.guard';
import { OauthCredentialsService } from '../oauth/oauth.service';
import { SetSourceTokenDto } from './dto/set-source-token.dto';
import { SourcesService } from './sources.service';

/**
 * Sources a **cle personnelle** (BYOT), c'est-a-dire celles qui n'ont pas de flux OAuth
 * utilisateur. TMDB est le cas du monolithe : l'utilisateur colle sa cle API, elle est
 * stockee chiffree dans `oauth_credentials` comme les autres, et le resolveur la privilegie.
 *
 * La route est generalisee en `/v1/sources/:provider/token` la ou le monolithe codait
 * `tmdb` en dur : une route par source aurait fait diverger deux implementations du meme
 * geste. (L'ancien `catalog-lego` servait la meme forme pour Rebrickable ; refait le
 * 2026-11-17, il n'a plus aucune cle personnelle.)
 */
@ApiTags('sources')
@ApiBearerAuth()
@Controller('sources')
@UseGuards(PrincipalGuard)
export class SourcesController {
  constructor(
    private readonly sources: SourcesService,
    private readonly credentials: OauthCredentialsService,
  ) {}

  /** Sources a cle personnelle connectees, et celles qui peuvent l'etre. */
  @Get()
  async list(@CurrentUserId() userId: string) {
    return this.sources.list(userId);
  }

  /**
   * Enregistre ou remplace la cle personnelle. Aucune validation aupres du fournisseur :
   * une cle invalide echouera au premier appel reel. Verifier a la saisie couterait un
   * appel sortant par enregistrement pour un gain que le premier usage donne gratuitement.
   */
  @Put(':provider/token')
  @HttpCode(HttpStatus.NO_CONTENT)
  async setToken(
    @CurrentUserId() userId: string,
    @Param('provider') provider: string,
    @Body() dto: SetSourceTokenDto,
  ): Promise<void> {
    await this.sources.setToken(userId, provider, dto.token);
  }

  /** Supprime la cle personnelle. Idempotent. */
  @Delete(':provider/token')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeToken(
    @CurrentUserId() userId: string,
    @Param('provider') provider: string,
  ): Promise<void> {
    await this.sources.removeToken(userId, provider);
  }
}
