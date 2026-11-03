/**
 * Normalisation des codes-barres de boites LEGO.
 *
 * Une boite porte un EAN-13 (Europe) ou un UPC-A (Amerique du Nord) - souvent les deux, sur deux
 * faces. Brickset publie les deux champs, mais formates de facon inconstante ("5 702016 616 331",
 * "0673419340496"). Le scanner de l'app, lui, rend une suite de chiffres nue.
 *
 * Deux regles suffisent a rapprocher les trois formes :
 *  - on ne garde que les chiffres ;
 *  - un UPC-A est un EAN-13 dont le zero de tete a ete omis. Un scan de 12 chiffres doit donc
 *    aussi etre cherche prefixe de "0", et un EAN-13 commencant par "0" aussi cherche ampute.
 *    Sans cette equivalence, une boite nord-americaine scannee en Europe ne se retrouve pas.
 */
export function normalizeBarcode(raw: string): string {
  let digits = '';
  for (const ch of raw) {
    if (ch >= '0' && ch <= '9') digits += ch;
  }
  return digits;
}

/**
 * Toutes les formes sous lesquelles un code scanne peut avoir ete indexe.
 * Retourne toujours la forme normalisee en premier.
 */
export function barcodeVariants(raw: string): string[] {
  const digits = normalizeBarcode(raw);
  if (!digits) return [];

  const variants = [digits];
  if (digits.length === 12) {
    variants.push(`0${digits}`);
  } else if (digits.length === 13 && digits.startsWith('0')) {
    variants.push(digits.slice(1));
  }
  return variants;
}
