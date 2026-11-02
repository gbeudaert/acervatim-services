import { GUARDS_METADATA } from '@nestjs/common/constants';
import { PaymentRequiredException } from '../../common/errors';
import { AdminGuard } from '../../common/guards/admin.guard';
import { PrincipalGuard } from '../../common/guards/principal.guard';
import { Principal } from '../../common/guards/principal.types';
import { SeriesUpdatesController } from './series-updates.controller';

function guardsOf(method: keyof SeriesUpdatesController): unknown[] {
  return (
    Reflect.getMetadata(
      GUARDS_METADATA,
      SeriesUpdatesController.prototype[method],
    ) ?? []
  );
}

function principal(premium: boolean): Principal {
  return { userId: 'u1', premium, exp: 0, origin: 'gateway' };
}

describe('SeriesUpdatesController', () => {
  it('GET series-updates : principal requis', () => {
    expect(guardsOf('list')).toEqual([PrincipalGuard]);
  });

  it('POST admin/edition-watch/run : jeton admin seulement, aucune garde de classe', () => {
    expect(guardsOf('run')).toEqual([AdminGuard]);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, SeriesUpdatesController),
    ).toBeUndefined();
  });

  it('délègue la lecture au service pour l’utilisateur du principal', async () => {
    const watch = {
      seriesUpdates: jest.fn().mockResolvedValue({ updates: [] }),
    };
    const ctrl = new SeriesUpdatesController(watch as never);
    await expect(ctrl.list(principal(true))).resolves.toEqual({ updates: [] });
    expect(watch.seriesUpdates).toHaveBeenCalledWith('u1');
  });

  it('principal non premium : 402 sans lecture (appel hors gateway, ou mode autonome)', async () => {
    const watch = { seriesUpdates: jest.fn() };
    const ctrl = new SeriesUpdatesController(watch as never);
    await expect(ctrl.list(principal(false))).rejects.toBeInstanceOf(
      PaymentRequiredException,
    );
    expect(watch.seriesUpdates).not.toHaveBeenCalled();
  });
});
