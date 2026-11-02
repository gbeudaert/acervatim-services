import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { PrincipalGuard } from '../common/guards/principal.guard';
import { PremiumClientService } from './premium-client.service';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller('me')
@UseGuards(PrincipalGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly premium: PremiumClientService,
  ) {}

  @Get()
  async me(@CurrentUserId() userId: string) {
    const [me, premium] = await Promise.all([
      this.users.findById(userId),
      this.premium.status(userId),
    ]);
    return { ...me, premium };
  }

  /**
   * Telechargement nomme, comme dans le monolithe. Le gateway retransmet
   * `Content-Disposition` : sans lui, l'export cesserait d'etre un fichier et deviendrait
   * un corps JSON affiche dans le navigateur.
   */
  @Get('export')
  async export(@CurrentUserId() userId: string, @Res() res: Response) {
    const payload = await this.users.exportMe(userId);
    const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const filename = `acervatim-export-${userId}-${yyyymmdd}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(HttpStatus.OK).send(JSON.stringify(payload, jsonReplacer));
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  async delete(@CurrentUserId() userId: string) {
    return this.users.deleteMe(userId);
  }
}

/**
 * Les fragments d'export venus des autres services portent des `BigInt` serialises en
 * chaine par leur propre couche HTTP ; ceux d'identity peuvent encore en contenir. On garde
 * le remplaceur du monolithe : `JSON.stringify` leve sur un `BigInt` nu, et un export qui
 * echoue a la serialisation est un droit RGPD qui echoue.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
