import { normalizeBarcode } from './barcode';
import { BricksetSet } from './brickset.types';

/** Un code-barres plausible : EAN-8 / UPC-E au plus court, EAN-14 au plus long. */
const MIN_CODE_LENGTH = 8;
const MAX_CODE_LENGTH = 14;

/** Les colonnes qu'une reponse Brickset a le droit d'ecrire - et aucune autre. */
export interface BricksetPatch {
  ean?: string;
  upc?: string;
  bricksetId?: number;
}

/** "42131" + variante 1 -> "42131-1", la forme canonique cote Rebrickable. */
export function bricksetSetNum(s: BricksetSet): string | null {
  if (!s.number) return null;
  const variant = s.numberVariant && s.numberVariant > 0 ? s.numberVariant : 1;
  return `${s.number}-${variant}`;
}

/**
 * Ce que Brickset apporte a un set connu, ou `null` s'il n'apporte rien.
 *
 * Un code vide (ou implausible) est **ignore**, jamais ecrit : il effacerait un code connu. Une
 * fiche sans aucun code n'ecrit rien du tout, pas meme `bricksetId` - sinon `contributedBy`
 * annoncerait une contribution qui n'existe pas.
 */
export function bricksetPatch(
  s: BricksetSet,
  current: {
    ean: string | null;
    upc: string | null;
    bricksetId: number | null;
  },
): BricksetPatch | null {
  const ean = plausibleCode(s.barcode?.EAN);
  const upc = plausibleCode(s.barcode?.UPC);
  if (!ean && !upc) return null;

  const patch: BricksetPatch = {};
  if (ean && ean !== current.ean) patch.ean = ean;
  if (upc && upc !== current.upc) patch.upc = upc;
  if (
    typeof s.setID === 'number' &&
    s.setID > 0 &&
    s.setID !== current.bricksetId
  ) {
    patch.bricksetId = s.setID;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Code ecrit en base, ou `null` s'il est implausible. Un GTIN-14 a zero de tete est ramene a ses
 * 13 chiffres : c'est l'EAN-13 de la boite, et la forme stockee doit etre celle qu'un scan
 * retrouve (`barcodeVariants` ne connait que 12 et 13 chiffres).
 */
export function plausibleCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = normalizeBarcode(raw);
  if (digits.length === 14 && digits.startsWith('0')) digits = digits.slice(1);
  return digits.length >= MIN_CODE_LENGTH && digits.length <= MAX_CODE_LENGTH
    ? digits
    : null;
}

/**
 * `true` si la fiche porte le code scanne, sous l'une de ses formes (`barcodeVariants`).
 *
 * Indispensable : `query` cherche aussi dans les numeros et les noms, et une fiche rendue pour
 * une autre raison ne doit pas recevoir le code.
 */
export function carriesCode(s: BricksetSet, variants: string[]): boolean {
  const ean = plausibleCode(s.barcode?.EAN);
  const upc = plausibleCode(s.barcode?.UPC);
  return (
    (ean !== null && variants.includes(ean)) ||
    (upc !== null && variants.includes(upc))
  );
}
