import {
  MangaItemSchema,
  MangaSerieSchema,
} from '../catalog-core/src/types/manga';

/*
 * Repris du monolithe (`collections/types/profiles.spec.ts`, SD2). Les schemas vivent dans
 * `catalog-core`, qui ne se teste pas seul : c'est le catalog qui sert le type qui les verifie.
 */
describe('Edition dans le contrat de synchro (SD2)', () => {
  it("le tome porte l'edition (le schema strict la refusait)", () => {
    const parsed = MangaItemSchema.parse({
      type: 'manga',
      edition: 'Éd. colossale',
    });
    expect(parsed.edition).toBe('Éd. colossale');
    expect(MangaItemSchema.parse({ type: 'manga' }).edition).toBeNull();
  });

  it('la serie porte edition, editeur et mangaId (le schema strip les supprimait)', () => {
    const parsed = MangaSerieSchema.parse({
      title: "L'attaque des titans",
      edition: null,
      publisherFr: 'France loisirs',
      mangaId: '304ceac3-8cdb-4fe7-acf7-2b6ff7a60613',
    });
    expect(parsed).toMatchObject({
      edition: null,
      publisherFr: 'France loisirs',
      mangaId: '304ceac3-8cdb-4fe7-acf7-2b6ff7a60613',
    });
  });

  it('defauts null quand absents (noeuds deja synchronises)', () => {
    const parsed = MangaSerieSchema.parse({ title: 'X' });
    expect(parsed.edition).toBeNull();
    expect(parsed.publisherFr).toBeNull();
    expect(parsed.mangaId).toBeNull();
  });
});
