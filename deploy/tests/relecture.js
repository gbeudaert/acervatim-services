// Relecture des donnees reprises, a travers le gateway, au nom de chaque utilisateur repris :
// l'etape 9 de deploiement.sh. Ce que la base seule ne prouve pas : que les services relisent
// ce que la reprise a ecrit, routage par le registre compris.
//
// Lancee dans le conteneur `identity`, qui a la cle JWT et `jsonwebtoken` :
//
//   podman exec -i acervatim-identity node -e "$(cat relecture.js)" < attendu.tsv
//
// Entree (TSV, tiree d'acv_legacy, c'est-a-dire du monolithe) :
//   U <userId>
//   C <userId> <collectionId> <nombre d'items>
//
// Pour chaque utilisateur : /v1/me repond, /v1/collections rend toutes ses collections (402 pour
// un compte sans premium, comme dans le monolithe ; les
// collections d'autrui qu'il voit par un partage sont comptees a part), et chaque collection
// rend son nombre d'items. Aucune ecriture. Sortie : `relecture conforme` ou la liste des
// ecarts (identifiants seulement), code 1.
'use strict';

const jwt = require('jsonwebtoken');

const GATEWAY = process.env.RELECTURE_GATEWAY_URL || 'http://localhost:3100';
const KEY = (process.env.JWT_PRIVATE_KEY || '').split('\\n').join('\n');

const ecarts = [];
let requetes = 0;
let partagees = 0;
let sansPremium = 0;
let nonRelues = 0;

function lireEntree() {
  return new Promise((resolve) => {
    let texte = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (texte += d));
    process.stdin.on('end', () => resolve(texte));
  });
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// GET au nom d'un utilisateur, avec un jeton de 5 minutes signe comme le fait identity. Les
// services aval ont un limiteur : un 429 attend `retry-after` puis rejoue.
async function get(userId, chemin) {
  const token = jwt.sign({ sub: userId }, KEY, { algorithm: 'RS256', expiresIn: '5m' });
  for (let essai = 0; essai < 6; essai += 1) {
    requetes += 1;
    const res = await fetch(`${GATEWAY}${chemin}`, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 429) {
      const attente = Number(res.headers.get('retry-after')) || 2;
      await pause(Math.min(attente, 30) * 1000);
      continue;
    }
    const texte = await res.text();
    let corps = null;
    try {
      corps = texte ? JSON.parse(texte) : null;
    } catch {
      corps = null;
    }
    return { status: res.status, corps };
  }
  return { status: 429, corps: null };
}

// Toutes les pages d'une liste paginee par curseur (meta.pagination.nextCursor).
async function tout(userId, chemin) {
  const lignes = [];
  let curseur = null;
  for (let page = 0; page < 1000; page += 1) {
    const sep = chemin.includes('?') ? '&' : '?';
    const suite = curseur ? `&cursor=${encodeURIComponent(curseur)}` : '';
    const r = await get(userId, `${chemin}${sep}limit=100${suite}`);
    if (r.status !== 200) return { status: r.status, lignes };
    lignes.push(...(r.corps?.data ?? []));
    curseur = r.corps?.meta?.pagination?.nextCursor ?? null;
    if (!curseur) return { status: 200, lignes };
  }
  return { status: 'pagination sans fin', lignes };
}

async function main() {
  if (!KEY) throw new Error('JWT_PRIVATE_KEY absente de l environnement');
  const utilisateurs = new Map();
  const proprietaire = new Map();
  for (const ligne of (await lireEntree()).split('\n')) {
    const [genre, userId, collectionId, items] = ligne.replace(/\r$/, '').split('\t');
    if (genre === 'U') utilisateurs.set(userId, utilisateurs.get(userId) ?? new Map());
    if (genre === 'C') {
      if (!utilisateurs.has(userId)) utilisateurs.set(userId, new Map());
      utilisateurs.get(userId).set(collectionId, Number(items));
      proprietaire.set(collectionId, userId);
    }
  }

  let collections = 0;
  let items = 0;
  for (const [userId, attendues] of utilisateurs) {
    const me = await get(userId, '/v1/me');
    if (me.status !== 200) {
      ecarts.push(`utilisateur ${userId} : /v1/me ${me.status}`);
      continue;
    }
    const liste = await tout(userId, '/v1/collections');
    // La synchronisation des collections est reservee au premium : 402 est la reponse attendue
    // pour un compte que /v1/me dit sans premium (et elle l'etait deja dans le monolithe). Ses
    // collections ne se relisent pas par le gateway ; la reprise les a controlees en base.
    if (liste.status === 402 && me.corps?.premium?.isPremium === false) {
      sansPremium += 1;
      nonRelues += attendues.size;
      continue;
    }
    if (liste.status !== 200) {
      ecarts.push(`utilisateur ${userId} : /v1/collections ${liste.status}`);
      continue;
    }
    const rendues = new Set(liste.lignes.map((c) => c.id));
    for (const id of rendues) {
      if (attendues.has(id)) continue;
      if (proprietaire.has(id)) partagees += 1;
      else ecarts.push(`utilisateur ${userId} : collection inconnue ${id}`);
    }
    for (const [collectionId, nombre] of attendues) {
      if (!rendues.has(collectionId)) {
        ecarts.push(`utilisateur ${userId} : collection ${collectionId} absente`);
        continue;
      }
      const contenu = await tout(userId, `/v1/collections/${collectionId}/items`);
      if (contenu.status !== 200) {
        ecarts.push(`collection ${collectionId} : items ${contenu.status}`);
      } else if (contenu.lignes.length !== nombre) {
        ecarts.push(`collection ${collectionId} : ${contenu.lignes.length} items au lieu de ${nombre}`);
      }
      collections += 1;
      items += contenu.lignes.length;
    }
  }

  console.log(
    `${utilisateurs.size} utilisateurs, ${collections} collections, ${items} items relus ` +
      `(${requetes} requetes, ${partagees} collections vues par partage)`,
  );
  if (sansPremium > 0) {
    console.log(
      `${sansPremium} compte(s) sans premium : 402 attendu sur /v1/collections, ` +
        `${nonRelues} collection(s) controlee(s) en base seulement`,
    );
  }
  if (ecarts.length > 0) {
    for (const e of ecarts.slice(0, 50)) console.log(`KO  ${e}`);
    if (ecarts.length > 50) console.log(`... et ${ecarts.length - 50} autres`);
    console.log(`relecture : ${ecarts.length} ecart(s)`);
    process.exit(1);
  }
  console.log('relecture conforme');
}

main().catch((e) => {
  console.log(`relecture impossible : ${e.message}`);
  process.exit(1);
});
