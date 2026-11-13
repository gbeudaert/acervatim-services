import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { BARCODE_FORMATS } from '../../common/barcode/gtin';

/**
 * Query de `GET /v1/search/boardgame/barcode/:code`. Le code lui-même est validé par
 * `normalizeGtin` (clé de contrôle comprise), pas par une regex de longueur : `400` sinon.
 */
export const BoardGameBarcodeQuerySchema = z
  .object({
    // Termes saisis par l'utilisateur quand les suggestions de GameUPC ne conviennent pas.
    q: z.string().trim().min(1).max(200).optional(),
    // Symbologie annoncée par le lecteur : indispensable pour un UPC-E (8 chiffres).
    format: z.enum(BARCODE_FORMATS).optional(),
  })
  .strict();

export class BoardGameBarcodeQueryDto extends createZodDto(
  BoardGameBarcodeQuerySchema,
) {}

/** Corps de `POST /v1/search/boardgame/barcode/:code/choice`. */
export const BoardGameChoiceSchema = z
  .object({
    bggId: z.number().int().positive(),
    // Édition choisie (langue, éditeur) ; absente = le jeu seul.
    versionId: z.number().int().positive().nullish(),
    format: z.enum(BARCODE_FORMATS).optional(),
  })
  .strict();

export class BoardGameChoiceDto extends createZodDto(BoardGameChoiceSchema) {}
