/**
 * Normalisation des codes-barres produit (EAN-13, EAN-8, UPC-A, UPC-E, GTIN-14).
 *
 * Pourquoi ici et pas chez la source : GameUPC **ne valide rien**. Mesuré le 2026-11-04 sur
 * `api.gameupc.com/test` : `abc` devient `000000000000` et rend un jeu au hasard, une clé de
 * contrôle fausse crée un enregistrement `new: true`, un UPC-E est complété par des zéros au lieu
 * d'être développé. Et il indexe la **chaîne** reçue : `019962194719` (UPC-A) est vérifié,
 * `0019962194719` (le même produit en EAN-13) est un autre enregistrement, non vérifié. Tout ce
 * qui part vers lui doit donc être validé et mis sous une forme unique avant l'appel.
 */

/** Symbologie annoncée par le lecteur (ML Kit la donne) : seul moyen de lever l'ambiguïté à 8 chiffres. */
export const BARCODE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'] as const;
export type BarcodeFormat = (typeof BARCODE_FORMATS)[number];

export interface Gtin {
  /** GTIN-13 canonique : clé de cache, indépendante de la forme scannée. */
  gtin13: string;
  /**
   * Forme attendue par les bases américaines (GameUPC) : 12 chiffres quand le GTIN-13 commence
   * par `0` (UPC-A, EAN-8 complété), 13 sinon. C'est sous cette forme que GameUPC vérifie.
   */
  upc: string;
  /** Symbologie retenue après normalisation. */
  format: BarcodeFormat;
}

/**
 * Normalise un code scanné ou saisi. `null` si ce n'est pas un GTIN de vente au détail valide
 * (caractères non numériques, longueur, clé de contrôle, GTIN-14 de colisage).
 *
 * - 13 chiffres : EAN-13, y compris les préfixes ISBN 978/979 (des jeux en portent, ex. Dixit FR).
 * - 12 chiffres : UPC-A.
 * - 11 chiffres : UPC-A dont le lecteur ou la saisie a perdu le `0` de tête (forme de la démo GameUPC).
 * - 8 chiffres : EAN-8 par défaut, UPC-E si `format === 'upc_e'` — les deux clés de contrôle sont
 *   souvent valides à la fois (`01234565` l'est pour les deux) : seul le lecteur sait.
 * - 14 chiffres : GTIN-14 d'indicateur `0` seulement ; un autre indicateur désigne un carton.
 */
export function normalizeGtin(
  raw: string,
  format?: BarcodeFormat,
): Gtin | null {
  const digits = raw.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(digits)) return null;

  switch (digits.length) {
    case 14:
      return digits.startsWith('0')
        ? fromGtin13(digits.slice(1), 'ean_13')
        : null;
    case 13:
      return fromGtin13(digits, 'ean_13');
    case 12:
      return fromGtin13(`0${digits}`, 'upc_a');
    case 11:
      return fromGtin13(`00${digits}`, 'upc_a');
    case 8: {
      if (format === 'upc_e') {
        const upcA = expandUpcE(digits);
        return upcA ? fromGtin13(`0${upcA}`, 'upc_e') : null;
      }
      return fromGtin13(`00000${digits}`, 'ean_8');
    }
    default:
      return null;
  }
}

function fromGtin13(gtin13: string, format: BarcodeFormat): Gtin | null {
  if (!hasValidCheckDigit(gtin13)) return null;
  return {
    gtin13,
    upc: gtin13.startsWith('0') ? gtin13.slice(1) : gtin13,
    format,
  };
}

/**
 * Clé de contrôle GS1 (modulo 10, poids 3 puis 1 en partant de la droite, clé exclue). Vaut pour
 * toutes les longueurs : un GTIN complété à gauche par des zéros garde la même clé.
 */
export function hasValidCheckDigit(digits: string): boolean {
  if (!/^\d{2,}$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = body.charCodeAt(body.length - 1 - i) - 48;
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10 === digits.charCodeAt(digits.length - 1) - 48;
}

/**
 * Développe un UPC-E (8 chiffres : système de numérotation, six chiffres, clé) en UPC-A
 * (12 chiffres). La clé est conservée : elle se calcule sur la forme développée. `null` si le
 * système n'est ni 0 ni 1 (ce n'est pas un UPC-E).
 */
export function expandUpcE(upcE: string): string | null {
  if (!/^[01]\d{7}$/.test(upcE)) return null;
  const ns = upcE[0];
  const d = upcE.slice(1, 7);
  const check = upcE[7];
  const last = d[5];

  let body: string;
  if (last <= '2') {
    body = `${d[0]}${d[1]}${last}0000${d[2]}${d[3]}${d[4]}`;
  } else if (last === '3') {
    body = `${d[0]}${d[1]}${d[2]}00000${d[3]}${d[4]}`;
  } else if (last === '4') {
    body = `${d[0]}${d[1]}${d[2]}${d[3]}00000${d[4]}`;
  } else {
    body = `${d[0]}${d[1]}${d[2]}${d[3]}${d[4]}0000${last}`;
  }
  return `${ns}${body}${check}`;
}
