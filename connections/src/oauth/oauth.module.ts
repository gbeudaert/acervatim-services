import { Module } from '@nestjs/common';
import { OAUTH_FLOW_PROVIDERS, OAuthFlowRegistry } from './oauth-flow.registry';
import { OauthController } from './oauth.controller';
import { OauthCredentialsService } from './oauth.service';
import { DiscogsFlow } from './providers/discogs.flow';
import { MalFlow } from './providers/mal.flow';
import { PendingCleanupService } from './pending-cleanup.service';
import { TokenResolverService } from './token-resolver.service';

/**
 * Les flux d'autorisation et le stockage des credentials.
 *
 * TMDB n'apparait pas dans `OAUTH_FLOW_PROVIDERS` : il n'a pas de flux utilisateur, sa cle
 * se colle par `PUT /v1/sources/tmdb/token`. Sa route `/start` renvoie donc 404, ce qui est
 * exactement le comportement du monolithe.
 */
@Module({
  controllers: [OauthController],
  providers: [
    OauthCredentialsService,
    TokenResolverService,
    OAuthFlowRegistry,
    DiscogsFlow,
    MalFlow,
    PendingCleanupService,
    {
      provide: OAUTH_FLOW_PROVIDERS,
      useFactory: (discogs: DiscogsFlow, mal: MalFlow) => [discogs, mal],
      inject: [DiscogsFlow, MalFlow],
    },
  ],
  exports: [OauthCredentialsService, TokenResolverService],
})
export class OauthModule {}
