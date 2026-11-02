import { BadRequestException } from '@nestjs/common';
import { ServiceName } from '../routing/service-registry.service';

/**
 * Curseur composite du scatter-gather (3.7 de architecture-microservices.md).
 *
 * **Le point le plus facile a casser en silence de toute la cible.** Un curseur opaque
 * unique ne decrit plus une position des lors que la liste est la fusion de N listes
 * independantes : il faut une position **par service**, encodees ensemble et opaques vues
 * du client. Une pagination qui saute ou duplique des lignes ne leve aucune erreur - elle
 * se contente de faire disparaitre des collections d'une galerie, ce que personne ne
 * signale comme un bug de pagination.
 *
 * Encodage : base64url d'un objet `{ <service>: <position> }`. La position vaut soit
 * l'identifiant de la derniere ligne consommee chez ce service, soit {@link EXHAUSTED}
 * quand son flux est epuise - auquel cas on cesse de l'interroger, ce qui evite N requetes
 * vides a chaque page suivante d'une liste dominee par un seul type.
 */

/** Marqueur « ce service n'a plus rien a donner ». */
export const EXHAUSTED = '$';

export type CompositeCursor = Partial<Record<ServiceName, string>>;

export function encodeCompositeCursor(cursor: CompositeCursor): string | null {
  const entries = Object.entries(cursor).filter(([, v]) => Boolean(v));
  if (entries.length === 0) return null;
  return Buffer.from(JSON.stringify(Object.fromEntries(entries)), 'utf8').toString(
    'base64url',
  );
}

/**
 * Un curseur illisible est un `400`, pas une page 1 silencieuse.
 *
 * C'est le choix inverse de celui fait pour la recherche externe, ou un curseur invalide
 * retombe sur la premiere page - la, le curseur est un numero de page cote Discogs, et
 * recommencer est inoffensif. Ici, repartir du debut au milieu d'une pagination rendrait
 * les doublons indiscernables d'un defaut de fusion, exactement le silence qu'on cherche
 * a eviter.
 */
export function decodeCompositeCursor(raw: string | undefined): CompositeCursor {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('cursor: malformed');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadRequestException('cursor: malformed');
  }
  const out: CompositeCursor = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new BadRequestException('cursor: malformed');
    }
    out[key as ServiceName] = value;
  }
  return out;
}

/** Une ligne de collection, vue du gateway : juste ce qu'il faut pour ordonner la fusion. */
export interface SortableCollection {
  id: string;
  createdAt: string;
  [key: string]: unknown;
}

/**
 * Ordre stable `(createdAt desc, id desc)` - **le meme que celui des catalogs**. Le
 * tiebreaker sur l'identifiant n'est pas cosmetique : deux collections creees dans la meme
 * milliseconde (import en masse, jeu de tests) se retrouveraient sinon dupliquees ou sautees
 * a la frontiere de deux pages, sans qu'aucun code n'echoue.
 */
export function compareCollections(
  a: SortableCollection,
  b: SortableCollection,
): number {
  const byDate = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (byDate !== 0) return byDate;
  return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
}
