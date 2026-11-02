import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { PrincipalGuard } from '../common/guards/principal.guard';
import { OAuthFlowRegistry } from './oauth-flow.registry';
import { OauthCredentialsService } from './oauth.service';

@ApiTags('oauth')
@Controller('oauth')
export class OauthController {
  constructor(
    private readonly registry: OAuthFlowRegistry,
    private readonly credentials: OauthCredentialsService,
  ) {}

  /** Demarre le flux : renvoie l'URL d'autorisation a ouvrir cote app. */
  @Get(':provider/start')
  @UseGuards(PrincipalGuard)
  @ApiBearerAuth()
  async start(
    @CurrentUserId() userId: string,
    @Param('provider') provider: string,
  ): Promise<{ authorizeUrl: string }> {
    return this.registry.get(provider).start(userId);
  }

  /**
   * Callback du provider - **non authentifie**, et il ne peut pas l'etre : le navigateur qui
   * revient de Discogs ou de MAL ne porte aucun JWT. L'identite est retablie par le jeton de
   * requete en attente, stocke au `start` avec un TTL de dix minutes.
   *
   * Le gateway route cette URL en `auth: 'public'` pour la meme raison.
   */
  @Get(':provider/callback')
  async callback(
    @Param('provider') provider: string,
    @Query() query: Record<string, string>,
  ): Promise<{ status: 'connected'; provider: string }> {
    await this.registry.get(provider).callback(query);
    return { status: 'connected', provider };
  }

  /** Providers connectes. Ne renvoie jamais le jeton, meme chiffre. */
  @Get()
  @UseGuards(PrincipalGuard)
  @ApiBearerAuth()
  async list(
    @CurrentUserId() userId: string,
  ): Promise<{ data: Array<{ provider: string; expiresAtMs: number }> }> {
    return { data: await this.credentials.listConnected(userId) };
  }

  /** Revoque les credentials de ce provider pour cet utilisateur. */
  @Delete(':provider')
  @UseGuards(PrincipalGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUserId() userId: string,
    @Param('provider') provider: string,
  ): Promise<void> {
    // 404 si le provider n'a pas de flux OAuth : la registry valide et affine le type.
    const flow = this.registry.get(provider);
    await this.credentials.remove(userId, flow.provider);
  }
}
