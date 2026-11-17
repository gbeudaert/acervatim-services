import {
  BadGatewayException,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalLegoSet } from '../../common/internal/contracts';
import {
  InternalCallError,
  InternalClientService,
} from '../../common/internal/internal-client.service';
import {
  BARCODE_TIMEOUT_MS,
  RebrickableAdapter,
  toUnifiedItem,
} from './rebrickable.adapter';

const BASE = 'http://rebrickable-data:3190';
const CTX = { userId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', limit: 20 };

const SET: InternalLegoSet = {
  setNum: '42131-1',
  setNumber: '42131',
  name: 'Cat D11 Bulldozer',
  year: 2021,
  numParts: 3854,
  minifigs: 0,
  imageUrl: 'https://cdn.rebrickable.com/media/sets/42131-1/97409.jpg',
  theme: { id: 1, name: 'Technic', path: 'Technic', slug: 'technic' },
  barcodes: { ean: '5702016914320', upc: null },
  contributedBy: ['rebrickable', 'brickset'],
};

function make(baseUrl: string | null = BASE) {
  const request = jest.fn();
  const internal = { request } as unknown as InternalClientService;
  const config = {
    get: jest.fn((k: string) =>
      k === 'REBRICKABLE_DATA_BASE_URL' ? (baseUrl ?? undefined) : undefined,
    ),
  } as unknown as ConfigService;
  const adapter = new RebrickableAdapter(internal, config);
  adapter.onModuleInit();
  return { adapter, request };
}

describe('RebrickableAdapter', () => {
  it('source rebrickable, type lego', () => {
    const { adapter } = make();
    expect(adapter.source).toBe('rebrickable');
    expect(adapter.mediaType).toBe('lego');
  });

  describe('search', () => {
    it('lit /internal/sets avec q, offset et limit, et mappe en UnifiedItem', async () => {
      const { adapter, request } = make();
      request.mockResolvedValue({ items: [SET], hasMore: true });

      const res = await adapter.search('bulldozer', CTX);

      expect(request).toHaveBeenCalledWith(
        BASE,
        '/internal/sets?q=bulldozer&offset=0&limit=20',
        { timeoutMs: undefined },
      );
      expect(res.items).toEqual([toUnifiedItem(SET)]);
      expect(res.nextCursor).toBe('1');
    });

    it('le curseur est le decalage de la page suivante', async () => {
      const { adapter, request } = make();
      request.mockResolvedValue({ items: [SET, SET], hasMore: false });

      const res = await adapter.search('42131', { ...CTX, cursor: '40' });

      expect(request.mock.calls[0][1]).toBe(
        '/internal/sets?q=42131&offset=40&limit=20',
      );
      expect(res.nextCursor).toBeNull();
    });

    it('encode la saisie', async () => {
      const { adapter, request } = make();
      request.mockResolvedValue({ items: [], hasMore: false });
      await adapter.search('star wars & co', CTX);
      expect(request.mock.calls[0][1]).toBe(
        '/internal/sets?q=star+wars+%26+co&offset=0&limit=20',
      );
    });

    it('curseur invalide : 400, sans appel', async () => {
      const { adapter, request } = make();
      for (const cursor of ['abc', '-1', '100001', '1.5']) {
        await expect(
          adapter.search('x', { ...CTX, cursor }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(request).not.toHaveBeenCalled();
    });

    it('rebrickable-data en erreur : 502', async () => {
      const { adapter, request } = make();
      request.mockRejectedValue(new InternalCallError('boom', 500, null));
      await expect(adapter.search('x', CTX)).rejects.toBeInstanceOf(
        BadGatewayException,
      );
    });

    it('rebrickable-data injoignable : le 502 du client interne remonte tel quel', async () => {
      const { adapter, request } = make();
      const err = new BadGatewayException('internal call failed');
      request.mockRejectedValue(err);
      await expect(adapter.search('x', CTX)).rejects.toBe(err);
    });

    it('sans REBRICKABLE_DATA_BASE_URL : 503, sans appel', async () => {
      const { adapter, request } = make(null);
      await expect(adapter.search('x', CTX)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(request).not.toHaveBeenCalled();
    });
  });

  describe('searchByBarcode', () => {
    it('attend 8 s et remonte lookup dans meta', async () => {
      const { adapter, request } = make();
      request.mockResolvedValue({ items: [SET], lookup: 'brickset' });

      const res = await adapter.searchByBarcode('5702016914320', CTX);

      expect(request).toHaveBeenCalledWith(
        BASE,
        '/internal/sets/by-barcode/5702016914320',
        { timeoutMs: BARCODE_TIMEOUT_MS },
      );
      expect(BARCODE_TIMEOUT_MS).toBe(8000);
      expect(res).toEqual({
        items: [toUnifiedItem(SET)],
        nextCursor: null,
        meta: { barcodeLookup: 'brickset' },
      });
    });

    it('aucun set : liste vide, lookup conserve (pending)', async () => {
      const { adapter, request } = make();
      request.mockResolvedValue({ items: [], lookup: 'pending' });
      const res = await adapter.searchByBarcode('5702016914320', CTX);
      expect(res.items).toEqual([]);
      expect(res.meta).toEqual({ barcodeLookup: 'pending' });
    });
  });

  describe('fetchDetails', () => {
    it('lit /internal/sets/:setNum', async () => {
      const { adapter, request } = make();
      request.mockResolvedValue(SET);
      await expect(adapter.fetchDetails('42131-1', CTX)).resolves.toEqual(
        toUnifiedItem(SET),
      );
      expect(request.mock.calls[0][1]).toBe('/internal/sets/42131-1');
    });

    it('set inconnu : 404', async () => {
      const { adapter, request } = make();
      request.mockRejectedValue(new InternalCallError('nf', 404, null));
      await expect(
        adapter.fetchDetails('99999-1', CTX),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('autre erreur : 502', async () => {
      const { adapter, request } = make();
      request.mockRejectedValue(new InternalCallError('boom', 503, null));
      await expect(
        adapter.fetchDetails('42131-1', CTX),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });
  });

  describe('toUnifiedItem', () => {
    it('suit la correspondance de la conception', () => {
      expect(toUnifiedItem(SET)).toEqual({
        source: 'rebrickable',
        sourceId: '42131-1',
        mediaType: 'lego',
        title: 'Cat D11 Bulldozer',
        creators: [],
        releaseDate: '2021',
        coverUrl: SET.imageUrl,
        metadata: {
          setNum: '42131-1',
          setNumber: '42131',
          theme: SET.theme,
          numParts: 3854,
          minifigs: 0,
          barcodes: SET.barcodes,
          contributedBy: ['rebrickable', 'brickset'],
        },
        rawData: SET,
      });
    });

    it('annee et image absentes : champs omis', () => {
      const u = toUnifiedItem({ ...SET, year: null, imageUrl: null });
      expect(u.releaseDate).toBeUndefined();
      expect(u.coverUrl).toBeUndefined();
    });
  });
});
