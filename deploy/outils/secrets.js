// Composition des secrets de la constellation a partir de ceux du monolithe (decision D2 de
// l'etude de deploiement : on reprend tout ce que le monolithe a, on ne genere que les secrets
// propres a la constellation).
//
// Lance par deploiement.sh dans une image de la constellation (node y est deja), sans reseau,
// le dossier `config/` du deploiement monte sur /sortie et le dossier `deploy/` de l'archive
// sur /acv. Aucune valeur n'est jamais ecrite sur la sortie standard : seulement des noms de
// cles et des empreintes tronquees.
//
//   node secrets.js composer        stdin : environnement du monolithe (JSON de `podman
//                                    container inspect --format '{{json .Config.Env}}'`, ou
//                                    contenu de son fichier .env) ; ecrit acervatim-secrets.yaml,
//                                    base.env, reglages.json, empreintes-monolithe
//   node secrets.js definir <CLE>   stdin : la valeur ; remplace celle de <CLE>
//   node secrets.js controler       chaque secretKeyRef du manifeste a sa cle
//   node secrets.js assembler       ecrit acervatim.yaml, le manifeste joue
//   node secrets.js empreintes      empreintes des secrets critiques de process.env
//   node secrets.js empreintes-entree   idem, depuis l'environnement lu sur stdin
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ACV = process.env.ACV_DIR || '/acv';
const SORTIE = process.env.ACV_SORTIE || '/sortie';
const GABARIT = path.join(ACV, 'acervatim-secrets.example.yaml');
const MANIFESTE = path.join(ACV, 'acervatim.yaml');
const SECRETS = path.join(SORTIE, 'acervatim-secrets.yaml');

// Generes ici parce que le monolithe ne les a pas : ils n'existent que dans la constellation.
// GAMEUPC_VOTER_PEPPER pseudonymise des votes : genere une fois, garde ensuite.
const GENERES = {
  INTERNAL_PRINCIPAL_SECRET: 48,
  INTERNAL_SERVICE_TOKEN: 48,
  GAMEUPC_VOTER_PEPPER: 32,
  ADMIN_API_TOKEN: 48,
};

// Vides a dessein, jamais demandes : BGG tant que la licence n'est pas ecrite.
const VIDES_A_DESSEIN = ['BGG_API_TOKEN'];

// Secrets dont une valeur differente de celle du monolithe rend les donnees reprises
// inaccessibles ou casse un parcours (db/reprise/README.md, 2). Compares avant la reprise.
const CRITIQUES = [
  'SUB_HASH_PEPPER',
  'ENCRYPTION_KEY',
  'JWT_PRIVATE_KEY',
  'JWT_PUBLIC_KEY',
  'INVITE_CODE_PEPPER',
  'SHARE_CODE_PEPPER',
  'GOOGLE_CLIENT_ID',
  'DISCOGS_CONSUMER_KEY',
  'DISCOGS_CONSUMER_SECRET',
  'MAL_CLIENT_ID',
  'MAL_CLIENT_SECRET',
  'GOOGLE_PLAY_PACKAGE_NAME',
  'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON',
  'GOOGLE_PUBSUB_SA_EMAIL',
  'GOOGLE_PUBSUB_AUDIENCE',
];

// Reglages non secrets du monolithe, reportes dans le ConfigMap du manifeste joue : le
// ConfigMap versionne n'a que des valeurs par defaut (CORS vide, contact fictif).
const REGLAGES_REPRIS = ['CORS_ORIGINS', 'HTTP_USER_AGENT'];

function fin(message) {
  process.stderr.write(`secrets: ${message}\n`);
  process.exit(1);
}

function lireEntree() {
  return fs.readFileSync(0, 'utf8');
}

// Environnement du monolithe. Le JSON de `podman inspect` est la source sure : c'est ce que
// le conteneur voit reellement. Le fichier .env n'est qu'un repli, lu comme le fait
// `podman --env-file` (tout ce qui suit le premier `=`, litteralement).
function lireEnvironnement(texte) {
  const env = {};
  const brut = texte.trim();
  let lignes;
  let source;
  if (brut.startsWith('[')) {
    lignes = JSON.parse(brut);
    source = 'conteneur';
  } else {
    lignes = brut.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    source = 'fichier';
  }
  for (const ligne of lignes) {
    const i = ligne.indexOf('=');
    if (i <= 0) continue;
    env[ligne.slice(0, i).trim()] = ligne.slice(i + 1);
  }
  return { env, source };
}

// Cles du Secret, dans l'ordre du gabarit, avec leur valeur d'exemple.
function clesDuGabarit(texte) {
  const cles = [];
  for (const ligne of texte.split(/\r?\n/)) {
    const m = /^ {2}([A-Z][A-Z0-9_]*): (.*)$/.exec(ligne);
    if (m) cles.push({ cle: m[1], exemple: m[2].trim().replace(/^'(.*)'$/, '$1') });
  }
  return cles;
}

// Une valeur YAML sure quelle qu'elle soit : une chaine JSON est une chaine YAML entre
// guillemets doubles valide, sauts de ligne et guillemets echappes compris.
function yaml(valeur) {
  return JSON.stringify(valeur);
}

function shell(valeur) {
  return `'${String(valeur).replace(/'/g, `'\\''`)}'`;
}

function empreinte(valeur) {
  if (valeur === undefined || valeur === '') return 'absent';
  return crypto.createHash('sha256').update(valeur, 'utf8').digest('hex').slice(0, 16);
}

function lignesEmpreintes(env) {
  return CRITIQUES.map((cle) => `${cle} ${empreinte(env[cle])}`).join('\n') + '\n';
}

function ecrire(fichier, contenu) {
  fs.writeFileSync(fichier, contenu, { mode: 0o600 });
  fs.chmodSync(fichier, 0o600);
}

// Une cle que le monolithe n'a pas reste HORS du Secret, en commentaire : la variable n'est
// alors pas definie dans les conteneurs, comme dans le monolithe. Une valeur vide, elle, est
// refusee par les validations qui l'acceptent absente (billing et GOOGLE_PLAY_*, releve a la
// repetition du 2026-11-21).
const ABSENTE = 'absente du monolithe, laissee hors du Secret';

function motifCle(cle) {
  return new RegExp(`^ {2}(?:# )?${cle}: .*$`, 'm');
}

function remplacerValeur(texte, cle, valeur) {
  const motif = motifCle(cle);
  if (!motif.test(texte)) fin(`cle ${cle} introuvable dans le fichier de secrets`);
  return texte.replace(motif, `  ${cle}: ${yaml(valeur)}`);
}

function retirerCle(texte, cle) {
  const motif = motifCle(cle);
  if (!motif.test(texte)) fin(`cle ${cle} introuvable dans le fichier de secrets`);
  return texte.replace(motif, `  # ${cle}: ${ABSENTE}`);
}

function clesAbsentes(texte) {
  return new Set([...texte.matchAll(new RegExp(`^ {2}# ([A-Z][A-Z0-9_]*): ${ABSENTE}`, 'gm'))].map((m) => m[1]));
}

function composer() {
  if (fs.existsSync(SECRETS)) fin(`${SECRETS} existe deja : il n'est jamais ecrase`);
  const { env, source } = lireEnvironnement(lireEntree());
  const gabarit = fs.readFileSync(GABARIT, 'utf8');
  const cles = clesDuGabarit(gabarit);

  if (!env.DATABASE_URL) fin('DATABASE_URL absente de l environnement du monolithe');
  let base;
  try {
    base = new URL(env.DATABASE_URL);
  } catch {
    fin('DATABASE_URL du monolithe illisible');
  }

  const rapport = { repris: [], derives: [], generes: [], absents: [], vides: [] };
  let sortie = gabarit.replace(
    /^# Gabarit du Secret[^\n]*\n/,
    `# Secret de la constellation, compose par deploiement.sh le ${new Date().toISOString()}\n` +
      `# depuis le monolithe (${source}). **Ne jamais versionner ni copier ce fichier.**\n#\n`,
  );

  for (const { cle, exemple } of cles) {
    let valeur;
    if (cle.startsWith('DATABASE_URL_')) {
      // Meme compte, meme instance que le monolithe (D1) ; seul le schema change.
      const schema = new URL(exemple).pathname;
      const url = new URL(base.href);
      url.pathname = schema;
      valeur = url.href;
      rapport.derives.push(cle);
    } else if (env[cle] !== undefined && env[cle] !== '') {
      valeur = env[cle];
      rapport.repris.push(cle);
    } else if (GENERES[cle]) {
      valeur = crypto.randomBytes(GENERES[cle]).toString('base64');
      rapport.generes.push(cle);
    } else if (VIDES_A_DESSEIN.includes(cle)) {
      valeur = '';
      rapport.vides.push(cle);
    } else {
      rapport.absents.push(cle);
      sortie = retirerCle(sortie, cle);
      continue;
    }
    sortie = remplacerValeur(sortie, cle, valeur);
  }

  // Origine publique, deduite des URL de retour OAuth : c'est l'adresse du reverse proxy.
  let publique = '';
  for (const cle of ['DISCOGS_CALLBACK_URL', 'MAL_CALLBACK_URL']) {
    if (!publique && env[cle]) {
      try {
        const u = new URL(env[cle]);
        if (!u.hostname.endsWith('example.org')) publique = u.origin;
      } catch {
        // URL de retour illisible : l'origine publique sera demandee.
      }
    }
  }

  const reglages = {
    dbHost: base.hostname,
    dbPort: base.port || '3306',
    configMap: {},
  };
  for (const cle of REGLAGES_REPRIS) {
    if (env[cle] !== undefined && env[cle] !== '') reglages.configMap[cle] = env[cle];
  }

  ecrire(SECRETS, sortie);
  ecrire(
    path.join(SORTIE, 'base.env'),
    [
      '# Compte SQL du monolithe, repris par la constellation (D1, D2). Lu par deploiement.sh.',
      `ACV_DB_HOST=${shell(base.hostname)}`,
      `ACV_DB_PORT=${shell(base.port || '3306')}`,
      `ACV_DB_USER=${shell(decodeURIComponent(base.username))}`,
      `ACV_DB_PASSWORD=${shell(decodeURIComponent(base.password))}`,
      `ACV_DB_MONOLITHE=${shell(base.pathname.replace(/^\//, '') || 'acervatim')}`,
      `ACV_URL_PUBLIQUE=${shell(publique)}`,
      '',
    ].join('\n'),
  );
  ecrire(path.join(SORTIE, 'reglages.json'), JSON.stringify(reglages, null, 2) + '\n');
  ecrire(path.join(SORTIE, 'empreintes-monolithe'), lignesEmpreintes(env));

  console.log(`source : ${source}`);
  console.log(`repris du monolithe (${rapport.repris.length}) : ${rapport.repris.join(' ')}`);
  console.log(`derives de DATABASE_URL (${rapport.derives.length}) : schemas acv_* sur ${base.hostname}`);
  console.log(`generes (${rapport.generes.length}) : ${rapport.generes.join(' ') || '-'}`);
  console.log(`vides a dessein : ${rapport.vides.join(' ') || '-'}`);
  console.log(`reglages repris dans le ConfigMap : ${Object.keys(reglages.configMap).join(' ') || '-'}`);
  for (const cle of rapport.absents) console.log(`ABSENT ${cle}`);
  if (!publique) console.log('ABSENTE origine publique (aucune URL de retour OAuth exploitable)');
}

function definir(cle) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(cle || '')) fin('usage : secrets.js definir <CLE>');
  const valeur = lireEntree().replace(/\r?\n$/, '');
  ecrire(SECRETS, remplacerValeur(fs.readFileSync(SECRETS, 'utf8'), cle, valeur));
}

// Chaque `secretKeyRef` du manifeste doit avoir sa cle dans le Secret, sinon le conteneur
// concerne ne demarre pas, et `podman kube play` le dit mal. Chaque cle du gabarit doit y etre,
// ou y etre notee absente du monolithe (une cle nouvelle du gabarit n'est pas oubliee).
function controler() {
  const secrets = fs.readFileSync(SECRETS, 'utf8');
  const presentes = new Set(clesDuGabarit(secrets).map((c) => c.cle));
  const absentes = clesAbsentes(secrets);
  const manifeste = fs.readFileSync(MANIFESTE, 'utf8');
  const attendues = new Set([...manifeste.matchAll(/^\s+key: ([A-Z][A-Z0-9_]*)\s*$/gm)].map((m) => m[1]));
  const gabarit = clesDuGabarit(fs.readFileSync(GABARIT, 'utf8')).map((c) => c.cle);
  const manquantes = [
    ...[...attendues].filter((c) => !presentes.has(c)),
    ...gabarit.filter((c) => !attendues.has(c) && !presentes.has(c) && !absentes.has(c)),
  ];
  if (manquantes.length > 0) {
    for (const cle of manquantes) console.log(`MANQUANTE ${cle}`);
    process.exit(1);
  }
  console.log(`${presentes.size} cles, ${absentes.size} absentes du monolithe, aucune manquante`);
}

// Manifeste joue = Secret + manifeste versionne, avec dans le ConfigMap l'adresse de la base du
// monolithe et les reglages repris. Chaque remplacement doit trouver sa ligne.
function assembler() {
  const secrets = fs.readFileSync(SECRETS, 'utf8');
  const reglages = JSON.parse(fs.readFileSync(path.join(SORTIE, 'reglages.json'), 'utf8'));
  let manifeste = fs.readFileSync(MANIFESTE, 'utf8');
  const valeurs = { DB_HOST: reglages.dbHost, DB_PORT: String(reglages.dbPort), ...reglages.configMap };
  for (const [cle, valeur] of Object.entries(valeurs)) {
    const motif = new RegExp(`^( {2}${cle}: ).*$`, 'm');
    if (!motif.test(manifeste)) fin(`${cle} introuvable dans le ConfigMap du manifeste`);
    manifeste = manifeste.replace(motif, (_, debut) => debut + yaml(valeur));
  }
  const separateur = secrets.endsWith('\n') ? '' : '\n';
  ecrire(path.join(SORTIE, 'acervatim.yaml'), secrets + separateur + manifeste);
  console.log(`manifeste joue ecrit (base ${reglages.dbHost}:${reglages.dbPort})`);
}

// Lance comme fichier (`node secrets.js composer`), depuis stdin (`node - empreintes`) ou par
// `node -e "<source>" empreintes` dans un conteneur de la constellation : process.argv differe.
const args = process.argv.slice(1);
if (args[0] === '-' || (args[0] || '').endsWith('.js')) args.shift();
const [mode, arg] = args;
switch (mode) {
  case 'composer':
    composer();
    break;
  case 'definir':
    definir(arg);
    break;
  case 'controler':
    controler();
    break;
  case 'assembler':
    assembler();
    break;
  case 'empreintes':
    process.stdout.write(lignesEmpreintes(process.env));
    break;
  case 'empreintes-entree':
    process.stdout.write(lignesEmpreintes(lireEnvironnement(lireEntree()).env));
    break;
  default:
    fin('mode inconnu (composer, definir, controler, assembler, empreintes, empreintes-entree)');
}
