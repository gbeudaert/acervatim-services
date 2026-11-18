import { ConfigService } from '@nestjs/config';
import { HashService } from '../common/crypto/hash.service';
import { AuditClientService } from '../common/internal/audit-client.service';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogClientService } from './catalog-client.service';
import { SharingService } from './sharing.service';

/*
 * Repris de `sharing/sharing.service.spec.ts` du monolithe, pour le demarrage seulement. Ses
 * autres cas (creation, redeem, revocation, libelles) sont rejoues contre une vraie base par la
 * suite d'integration : test/shares.int-spec.ts (`./scripts/dev.ps1 test-int sharing`).
 */

function serviceWithPepper(pepper: string | undefined): SharingService {
  const config = {
    get: jest.fn(() => pepper),
  } as unknown as ConfigService;
  return new SharingService(
    {} as PrismaService,
    config,
    new HashService(),
    { record: jest.fn() } as unknown as AuditClientService,
    {} as CatalogClientService,
  );
}

describe('SharingService.onModuleInit', () => {
  it('refuse de demarrer sans SHARE_CODE_PEPPER', () => {
    expect(() => serviceWithPepper(undefined).onModuleInit()).toThrow(
      /SHARE_CODE_PEPPER/,
    );
  });

  it('refuse un pepper trop court', () => {
    expect(() => serviceWithPepper('trop-court').onModuleInit()).toThrow(
      /SHARE_CODE_PEPPER/,
    );
  });

  it('demarre avec un pepper d au moins 32 caracteres', () => {
    expect(() =>
      serviceWithPepper('p'.repeat(32)).onModuleInit(),
    ).not.toThrow();
  });
});
