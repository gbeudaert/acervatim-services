import { CatalogInternalService } from '../catalog-core/src/internal/catalog-internal.service';

/*
 * Les deux routes internes lues par le rattrapage manga de `search` (`GET /internal/nodes`,
 * `GET /internal/users/:id/nodes`). `catalog-core` ne se testant pas seul, c'est le catalog qui
 * sert le type qui les verifie.
 */

type Row = { id: string; userId: string; unifiedData: unknown };

function make(
  rows: Row[],
  items: { nodeId: string | null; volume: number | null }[] = [],
) {
  const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const prisma = {
    collectionNode: {
      findMany: jest.fn(
        (args: {
          where: { userId?: string };
          take?: number;
          cursor?: { id: string };
          skip?: number;
        }) => {
          let out = sorted;
          if (args.where.userId) {
            out = out.filter((r) => r.userId === args.where.userId);
          }
          if (args.cursor) {
            const i = out.findIndex((r) => r.id === args.cursor!.id);
            out = out.slice(i + (args.skip ?? 0));
          }
          return Promise.resolve(args.take ? out.slice(0, args.take) : out);
        },
      ),
    },
    item: { findMany: jest.fn().mockResolvedValue(items) },
  };
  const svc = new CatalogInternalService(prisma as never, {} as never);
  return { svc, prisma };
}

const serie = (id: string, userId = 'u1'): Row => ({
  id,
  userId,
  unifiedData: { title: id },
});

describe('CatalogInternalService - noeuds pour le rattrapage manga', () => {
  it('nodesPage : filtre type + niveau, curseur sur le dernier id rendu', async () => {
    const { svc, prisma } = make([serie('a'), serie('b'), serie('c')]);

    const first = await svc.nodesPage('manga', 'serie', undefined, 2);

    expect(prisma.collectionNode.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { level: 'serie', collection: { typeCode: 'manga' } },
        take: 3,
        orderBy: { id: 'asc' },
      }),
    );
    expect(first).toEqual({
      nodes: [
        { nodeId: 'a', userId: 'u1', unifiedData: { title: 'a' } },
        { nodeId: 'b', userId: 'u1', unifiedData: { title: 'b' } },
      ],
      nextCursor: 'b',
    });

    const second = await svc.nodesPage('manga', 'serie', 'b', 2);
    expect(second.nodes.map((n) => n.nodeId)).toEqual(['c']);
    expect(second.nextCursor).toBeNull();
  });

  it('userNodes : volumes presents par noeud, tries et dedoublonnes', async () => {
    const { svc, prisma } = make(
      [serie('n1'), serie('n2'), serie('n9', 'autre')],
      [
        { nodeId: 'n1', volume: 3 },
        { nodeId: 'n1', volume: 1 },
        { nodeId: 'n1', volume: 3 },
        { nodeId: null, volume: 2 },
      ],
    );

    const res = await svc.userNodes('u1', 'manga', 'serie');

    expect(res).toEqual({
      nodes: [
        { nodeId: 'n1', unifiedData: { title: 'n1' }, volumes: [1, 3] },
        { nodeId: 'n2', unifiedData: { title: 'n2' }, volumes: [] },
      ],
    });
    expect(prisma.item.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'u1',
          nodeId: { in: ['n1', 'n2'] },
          volume: { not: null },
        },
      }),
    );
  });

  it("userNodes : aucun noeud, aucune lecture d'items", async () => {
    const { svc, prisma } = make([serie('n9', 'autre')]);
    expect(await svc.userNodes('u1', 'manga', 'serie')).toEqual({ nodes: [] });
    expect(prisma.item.findMany).not.toHaveBeenCalled();
  });
});
