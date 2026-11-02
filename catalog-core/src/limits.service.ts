import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CATALOG_DB, CatalogDb } from './db';

/**
 * 409 - plafond technique atteint. Duplique la classe du vocabulaire commun de chaque service
 * (`common/errors`) : `catalog-core` ne peut pas importer le `src/` de son consommateur, et
 * `ProblemDetailsExceptionFilter` reconnait l'instance par son **statut** 409, pas par son
 * identite de classe. La seule chose qui doit rester alignee est donc le code HTTP.
 */
export class TechnicalLimitException extends HttpException {
  constructor(message: string) {
    super(message, HttpStatus.CONFLICT);
  }
}

/**
 * Plafonds **techniques**, identiques pour tous les comptes.
 *
 * ### Ce que le decoupage par type leur fait (3.5)
 *
 * Dans le monolithe, ces plafonds comptaient par utilisateur **a travers toutes ses
 * collections**. Chaque catalog ne voit desormais que les siennes : un utilisateur qui possede
 * des collections de N types peut donc atteindre jusqu'a N fois le plafond unitaire.
 *
 * C'est assume, et c'est le bon arbitrage : ce plafond est un garde-fou anti-emballement - un
 * client qui boucle, un import qui derape -, pas une limite d'offre. La semantique survit au
 * decoupage ; seul le total effectif change, et il reste tres au-dessus de tout usage humain.
 * L'alternative - un service de comptage transverse interroge a chaque creation - ajouterait
 * un aller-retour reseau sur le chemin d'ecriture pour defendre un chiffre que personne ne
 * connait.
 *
 * Ils ne matérialisent aucun palier : la synchronisation est premium-only, et le premium ne les
 * lève pas. Ce sont des garde-fous anti-emballement — un client qui boucle, un import qui dérape —
 * volontairement hauts : un usage humain, même intensif, ne doit jamais les voir. Ils ne sont pas
 * communiqués à l'utilisateur et aucun endpoint ne les expose.
 */
export const TECHNICAL_LIMITS = {
  collections: 500,
  items: 100_000,
  // Les nœuds (séries) sont par construction bien moins nombreux que les items qu'ils regroupent.
  // Le plafond existe depuis qu'un nœud peut naître d'un simple `unifiedData` : la création n'est
  // plus adossée à un appel provider, donc plus freinée par rien d'autre.
  nodes: 20_000,
} as const;

/**
 * Accepte un client transactionnel (Prisma.TransactionClient) ou le client root
 * — permet à l'appelant d'enrôler le check dans la transaction de création
 * pour réduire la fenêtre TOCTOU.
 */
type DbClient = CatalogDb | Prisma.TransactionClient;

@Injectable()
export class LimitsService {
  constructor(@Inject(CATALOG_DB) private readonly prisma: CatalogDb) {}

  async assertCanCreateCollection(
    userId: string,
    db?: DbClient,
  ): Promise<void> {
    const client = db ?? this.prisma;
    const used = await client.collection.count({ where: { userId } });
    if (used >= TECHNICAL_LIMITS.collections) {
      throw new TechnicalLimitException(
        `technical-limit: max ${TECHNICAL_LIMITS.collections} collections`,
      );
    }
  }

  async assertCanCreateNode(userId: string, db?: DbClient): Promise<void> {
    const client = db ?? this.prisma;
    const used = await client.collectionNode.count({ where: { userId } });
    if (used >= TECHNICAL_LIMITS.nodes) {
      throw new TechnicalLimitException(
        `technical-limit: max ${TECHNICAL_LIMITS.nodes} nodes`,
      );
    }
  }

  async assertCanCreateItem(userId: string, db?: DbClient): Promise<void> {
    const client = db ?? this.prisma;
    const agg = await client.collection.aggregate({
      where: { userId },
      _sum: { itemCount: true },
    });
    const used = agg._sum.itemCount ?? 0;
    if (used >= TECHNICAL_LIMITS.items) {
      throw new TechnicalLimitException(
        `technical-limit: max ${TECHNICAL_LIMITS.items} items`,
      );
    }
  }
}
