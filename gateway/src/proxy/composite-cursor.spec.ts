import { BadRequestException } from '@nestjs/common';
import {
  compareCollections,
  decodeCompositeCursor,
  encodeCompositeCursor,
  EXHAUSTED,
} from './composite-cursor';

describe('curseur composite', () => {
  it('fait un aller-retour', () => {
    const cursor = { 'catalog-manga': 'a', 'catalog-vinyl': EXHAUSTED } as const;
    const encoded = encodeCompositeCursor({ ...cursor });
    expect(encoded).toBeTruthy();
    expect(decodeCompositeCursor(encoded!)).toEqual(cursor);
  });

  it('rend null quand il n y a aucune position', () => {
    expect(encodeCompositeCursor({})).toBeNull();
  });

  it('est opaque : rien du format interne ne fuit dans la valeur servie', () => {
    const encoded = encodeCompositeCursor({ 'catalog-manga': 'abc' })!;
    expect(encoded).not.toContain('catalog-manga');
    expect(encoded).not.toContain('{');
  });

  // Repartir silencieusement de la page 1 rendrait les doublons indiscernables d'un
  // defaut de fusion : c'est exactement le silence que le 3.7 demande d'eviter.
  it('refuse un curseur illisible plutot que de repartir du debut', () => {
    expect(() => decodeCompositeCursor('pas-du-base64-json')).toThrow(
      BadRequestException,
    );
    expect(() =>
      decodeCompositeCursor(Buffer.from('[1,2]').toString('base64url')),
    ).toThrow(BadRequestException);
    expect(() =>
      decodeCompositeCursor(Buffer.from('{"a":1}').toString('base64url')),
    ).toThrow(BadRequestException);
  });

  it('traite un curseur absent comme un debut de liste', () => {
    expect(decodeCompositeCursor(undefined)).toEqual({});
  });
});

describe('compareCollections', () => {
  const row = (createdAt: string, id: string) => ({ id, createdAt });

  it('ordonne du plus recent au plus ancien', () => {
    const rows = [
      row('2026-01-01T00:00:00.000Z', 'a'),
      row('2026-03-01T00:00:00.000Z', 'b'),
      row('2026-02-01T00:00:00.000Z', 'c'),
    ];
    expect(rows.sort(compareCollections).map((r) => r.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });

  // Sans ce tiebreaker, deux lignes creees dans la meme milliseconde peuvent etre
  // dupliquees ou sautees a la frontiere de deux pages, sans qu'aucun code n'echoue.
  it('departage par identifiant a date egale, dans le meme ordre que les catalogs', () => {
    const same = '2026-01-01T00:00:00.000Z';
    const rows = [row(same, 'a'), row(same, 'c'), row(same, 'b')];
    expect(rows.sort(compareCollections).map((r) => r.id)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  it('est total : trier deux fois ne change rien', () => {
    const same = '2026-01-01T00:00:00.000Z';
    const rows = [row(same, 'b'), row('2026-02-01T00:00:00.000Z', 'a'), row(same, 'c')];
    const once = [...rows].sort(compareCollections).map((r) => r.id);
    const twice = [...rows].sort(compareCollections).sort(compareCollections).map((r) => r.id);
    expect(twice).toEqual(once);
  });
});
