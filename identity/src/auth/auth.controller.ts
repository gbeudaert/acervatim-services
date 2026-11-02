import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { GoogleLoginDto } from './dto/google-login.dto';

/**
 * Echange credential externe -> JWT interne. **Aucun garde** : c'est la porte d'entree, il
 * n'y a pas encore d'identite a verifier. Le resserrage de debit (10/min) est applique par
 * le gateway, seul endroit ou compter les requetes d'un client ait un sens maintenant que
 * tout le trafic y passe.
 *
 * Un endpoint par provider, chacun avec son DTO Zod : la forme du credential varie
 * (`idToken` pour Google, `identityToken` + nonce pour Apple). Ajouter un provider = un DTO,
 * une methode de trois lignes, et son `IdentityProvider`.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('google')
  @HttpCode(HttpStatus.OK)
  async loginWithGoogle(@Body() dto: GoogleLoginDto) {
    return this.authService.loginWithProvider('google', dto);
  }
}
