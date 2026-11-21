// Controle d'une image avant de l'archiver (deploy/build-archive.ps1) : le node de l'image tourne
// dans l'architecture cible, et chaque moteur Prisma qu'elle porte est un binaire de cette
// architecture. C'est le piege documente : Prisma embarque le moteur de l'architecture du
// build, et une image au mauvais moteur n'echoue qu'au premier acces a la base, avec un message
// qui ne parle pas d'architecture.
//
//   docker run --rm --platform linux/arm64 -v <deploy/outils>:/controle:ro --entrypoint node \
//     <image> /controle/controle-image.js arm64
//
// Lit l'en-tete ELF (champ e_machine) au lieu d'executer les moteurs : sous emulation, un
// binaire de l'architecture de l'hote s'executerait quand meme et passerait le controle.
'use strict';

const fs = require('fs');
const path = require('path');

const cible = process.argv[2];
const ARCH_NODE = { arm64: 'arm64', amd64: 'x64' };
const MACHINE = { arm64: 0xb7, amd64: 0x3e };
const NOMS = { 0xb7: 'arm64', 0x3e: 'amd64' };

if (!ARCH_NODE[cible]) {
  console.log(`KO architecture cible inconnue : ${cible}`);
  process.exit(2);
}
if (process.arch !== ARCH_NODE[cible]) {
  console.log(`KO node tourne en ${process.arch}, attendu ${ARCH_NODE[cible]}`);
  process.exit(1);
}

const moteurs = [];
function parcourir(dossier, profondeur) {
  if (profondeur > 6) return;
  let entrees;
  try {
    entrees = fs.readdirSync(dossier, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entrees) {
    const chemin = path.join(dossier, e.name);
    if (e.isDirectory()) parcourir(chemin, profondeur + 1);
    else if (/^(libquery_engine|query-engine|query_engine|schema-engine)/.test(e.name)) moteurs.push(chemin);
  }
}
for (const racine of ['node_modules/.prisma', 'node_modules/@prisma', 'node_modules/prisma']) {
  parcourir(path.resolve(racine), 0);
}

function machine(fichier) {
  const fd = fs.openSync(fichier, 'r');
  const entete = Buffer.alloc(20);
  fs.readSync(fd, entete, 0, 20, 0);
  fs.closeSync(fd);
  if (entete.readUInt32BE(0) !== 0x7f454c46) return null;
  return entete.readUInt16LE(18);
}

const elf = moteurs.map((f) => ({ f, m: machine(f) })).filter((x) => x.m !== null);
if (elf.length === 0) {
  console.log(`KO aucun moteur Prisma trouve sous ${process.cwd()}/node_modules`);
  process.exit(1);
}
const faux = elf.filter((x) => x.m !== MACHINE[cible]);
if (faux.length > 0) {
  for (const x of faux) {
    console.log(`KO ${path.relative(process.cwd(), x.f)} est en ${NOMS[x.m] || `machine ${x.m}`}`);
  }
  process.exit(1);
}
// Les scripts du dossier de travail (migrate.sh) : un CR en fin de ligne casse le shebang, et
// l'initContainer echoue sans parler de fins de ligne.
const scripts = fs.readdirSync(process.cwd()).filter((f) => f.endsWith('.sh'));
for (const s of scripts) {
  if (fs.readFileSync(s).includes(0x0d)) {
    console.log(`KO ${s} a des fins de ligne CRLF`);
    process.exit(1);
  }
}

const suffixe = scripts.length > 0 ? `, ${scripts.join(' ')} en LF` : '';
console.log(`node ${process.arch}, ${elf.length} moteur(s) Prisma en ${cible}${suffixe}`);
