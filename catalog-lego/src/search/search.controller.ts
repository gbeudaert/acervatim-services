import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator';
import { PrincipalGuard } from '../common/guards/principal.guard';
import { Principal } from '../common/guards/principal.types';
import { ThemeNode } from '../common/sources/set-index/theme-sync.service';
import { UnifiedLegoSet } from '../common/sources/types';
import { LegoSearchQueryDto } from './dto/search.query';
import { LegoSearchPage, SearchService } from './search.service';

@ApiTags('search')
@ApiBearerAuth()
@Controller('search')
@UseGuards(PrincipalGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}

  /**
   * Trois entrees dans une seule route, comme le monolithe :
   *   - `?q=` recherche par nom ;
   *   - `?barcode=` scan d'une boite (index local, cf. `SearchService.byBarcode`) ;
   *   - `?theme=` navigation par type de set, combinable avec `q`.
   */
  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: LegoSearchQueryDto,
  ): Promise<LegoSearchPage> {
    return this.search.search(principal, query);
  }

  /** Arbre des types de set. `?parent=technic` descend d'un niveau. */
  @Get('themes')
  themes(@Query('parent') parent?: string): { data: ThemeNode[] } {
    return { data: this.search.listThemes(parent) };
  }

  /** Detail d'un set par son numero canonique ("42131-1"). */
  @Get('sets/:setNum')
  async set(
    @CurrentPrincipal() principal: Principal,
    @Param('setNum') setNum: string,
  ): Promise<UnifiedLegoSet> {
    return this.search.getSet(principal, setNum);
  }
}
