import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../../common/decorators/current-user-id.decorator';
import { PrincipalGuard } from '../../common/guards/principal.guard';
import {
  BoardGameBarcodeQueryDto,
  BoardGameChoiceDto,
} from '../dto/boardgame-barcode.dto';
import { BoardGameBarcodeService } from './boardgame-barcode.service';
import {
  BarcodeResolution,
  BoardGameChoiceResult,
} from './boardgame-barcode.types';

/**
 * Scan d'un jeu de société. Les données viennent de GameUPC et de BoardGameGeek : l'écran qui les
 * affiche porte le logo « Powered by BGG » lié à boardgamegeek.com (conditions BGG), et ces routes
 * restent derrière l'authentification — les données BGG ne se redistribuent pas par une API
 * publique.
 */
@ApiTags('search')
@ApiBearerAuth()
@Controller('search/boardgame')
@UseGuards(PrincipalGuard)
export class BoardGameBarcodeController {
  constructor(private readonly barcodes: BoardGameBarcodeService) {}

  /**
   * Résout un code. Toujours `200` sauf code invalide (`400`) : l'indisponibilité de GameUPC est un
   * statut (`unavailable`, ou réponse `stale`), pas une erreur, pour que l'app propose la suite.
   */
  @Get('barcode/:code')
  async resolve(
    @Param('code') code: string,
    @Query() query: BoardGameBarcodeQueryDto,
  ): Promise<BarcodeResolution> {
    return this.barcodes.resolve(code, { q: query.q, format: query.format });
  }

  /**
   * Choix de l'utilisateur parmi les candidats proposés. `202` : le vote GameUPC part en
   * arrière-plan. `409` si le jeu (ou la version) n'a pas été proposé pour ce code.
   */
  @Post('barcode/:code/choice')
  @HttpCode(202)
  async choose(
    @CurrentUserId() userId: string,
    @Param('code') code: string,
    @Body() body: BoardGameChoiceDto,
  ): Promise<BoardGameChoiceResult> {
    return this.barcodes.choose(
      userId,
      code,
      { bggId: body.bggId, versionId: body.versionId ?? null },
      body.format,
    );
  }
}
