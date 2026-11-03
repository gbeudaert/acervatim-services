// Parcours de bout en bout des donnees reprises du jeu complementaire, a travers le gateway.
//
// A jouer apres `reprise.sh transform` sur un acv_legacy enrichi de jeu-complementaire.sql :
//
//   docker compose exec -T identity node - < db/reprise/test/parcours.js
//
// Dans le conteneur `identity` parce qu'il a deja ce qu'il faut : la cle JWT pour signer au
// nom des utilisateurs du jeu, `jsonwebtoken`, et le reseau de la stack. Rien ne tourne sur
// l'hote. Ce que chaque assertion prouve est ecrit a cote : c'est le controle que la base
// seule ne peut pas faire - que les services relisent bien ce que la reprise a ecrit.

const jwt = require('jsonwebtoken');

const GATEWAY = process.env.REPRISE_GATEWAY_URL || 'http://gateway:3100';
const KEY = process.env.JWT_PRIVATE_KEY.split('\\n').join('\n');

const U1 = '7e570000-0000-4000-8000-000000000001';
const U2 = '7e570000-0000-4000-8000-000000000002';
const U3 = '7e570000-0000-4000-8000-000000000003';
const C1 = '7e570000-0000-4000-8000-000000000c01';
const C2 = '7e570000-0000-4000-8000-000000000c02';
const S1 = '7e570000-0000-4000-8000-000000000501';
const C1_NAME = 'Mangas d\'Ünïcødé 🎌 « guillemets » "doubles" \\ antislash';

let failures = 0;

function check(label, ok, detail) {
  console.log(`${ok ? 'OK' : 'KO'}  ${label}${ok ? '' : `  -> ${detail}`}`);
  if (!ok) failures += 1;
}

async function get(userId, path) {
  const token = jwt.sign({ sub: userId }, KEY, { algorithm: 'RS256', expiresIn: '5m' });
  const res = await fetch(`${GATEWAY}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  // billing : l'abonnement repris donne le premium.
  const me = await get(U1, '/v1/me');
  check('U1 premium par abonnement', me.body?.premium?.isPremium === true && me.body.premium.source === 'subscription', JSON.stringify(me.body?.premium));

  // catalogs + registre : les six collections de U1, reparties dans trois catalogs, sont
  // retrouvees par le scatter-gather, et le texte sur 4 octets est intact.
  const cols = await get(U1, '/v1/collections');
  const mine = (cols.body?.data ?? []).filter((c) => c.id.startsWith('7e570000'));
  check('U1 six collections, cinq types', mine.length === 6 && new Set(mine.map((c) => c.type)).size === 5, `${mine.length} collections`);
  check('U1 nom Unicode intact', mine.find((c) => c.id === C1)?.name === C1_NAME, mine.find((c) => c.id === C1)?.name);

  // catalog-manga, resolution par le registre : les tomes de la serie.
  const items = await get(U1, `/v1/collections/${C1}/items`);
  check('U1 tomes 1 a 3', same((items.body?.data ?? []).map((i) => i.volume).sort(), [1, 2, 3]), JSON.stringify(items.body));

  // connections : les liaisons OAuth reprises.
  const oauth = await get(U1, '/v1/oauth');
  check('U1 liaisons discogs et mal', same((oauth.body?.data ?? []).map((o) => o.provider).sort(), ['discogs', 'mal']), JSON.stringify(oauth.body));

  // sharing : le partage et ses copies du nom.
  const shares = await get(U1, '/v1/shares');
  const s1 = (Array.isArray(shares.body) ? shares.body : []).find((s) => s.id === S1);
  check('U1 partage S1 a deux collections', s1?.collections?.length === 2 && s1.collections.some((c) => c.name === C1_NAME), JSON.stringify(s1));

  // search : l'etat du rattrapage repris, lu contre les tomes possedes (1 a 3).
  const upd1 = await get(U1, '/v1/series-updates');
  check('U1 rattrapage : tome 4', same(upd1.body?.updates?.map((u) => [u.title, u.newTomes.map((t) => t.editionVolume)]), [['Saga de reprise', [4]]]), JSON.stringify(upd1.body));

  // sharing + catalogs : la vue membre, filtree par statuts.
  const received = await get(U2, '/v1/shares/received');
  const r1 = (Array.isArray(received.body) ? received.body : []).find((s) => s.shareId === S1);
  const counts = Object.fromEntries((r1?.collections ?? []).map((c) => [c.collectionId, c.itemCount]));
  check('U2 recoit S1 (3 tomes, 1 vinyle souhaite)', counts[C1] === 3 && counts[C2] === 1, JSON.stringify(r1));

  const wish = await get(U2, `/v1/collections/${C2}/items`);
  check('U2 voit le seul vinyle WISHLIST', same((wish.body?.data ?? []).map((i) => [i.title, i.status]), [['Björk — Homogenic', 'WISHLIST']]), JSON.stringify(wish.body));

  // billing par attribution + rattrapage : U2 n'a que le tome 1.
  const upd2 = await get(U2, '/v1/series-updates');
  check('U2 premium par attribution, tomes 3 et 4', same(upd2.body?.updates?.map((u) => u.newTomes.map((t) => t.editionVolume)), [[3, 4]]), JSON.stringify(upd2.body));

  // sharing : le membre revoque ne voit plus rien, sans qu'on lui dise pourquoi.
  const revoked = await get(U3, `/v1/collections/${C1}/items`);
  check('U3 revoque : 404', revoked.status === 404, `HTTP ${revoked.status}`);

  console.log(failures === 0 ? 'parcours conforme' : `${failures} assertion(s) KO`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
