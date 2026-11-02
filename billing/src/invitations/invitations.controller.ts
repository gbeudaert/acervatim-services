import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../common/decorators/current-user-id.decorator';
import { AdminGuard } from '../common/guards/admin.guard';
import { PrincipalGuard } from '../common/guards/principal.guard';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { RedeemInvitationDto } from './dto/redeem-invitation.dto';
import { InvitationsService } from './invitations.service';

@ApiTags('invitations')
@Controller()
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  /**
   * Creation - admin uniquement. Le `code` retourne n'est affiche qu'ici : seul son HMAC est
   * stocke, il n'est donc pas re-recuperable, y compris par nous.
   *
   * Le resserrage de debit (5/min) est applique par le gateway, comme pour toutes les
   * routes publiques.
   */
  @Post('admin/invitations')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateInvitationDto) {
    const { code, codeHash } = await this.invitations.create(dto);
    return { code, codeHash };
  }

  /** Consommation d'un code par l'utilisateur courant. */
  @Post('invitations/redeem')
  @UseGuards(PrincipalGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  async redeem(
    @Body() dto: RedeemInvitationDto,
    @CurrentUserId() userId: string,
  ) {
    return this.invitations.redeem(dto.code, userId);
  }
}
