// CI — le wrapper d'erreur commun est OBLIGATOIRE (plan v2 §5) :
//   1. toute fonction Netlify TypeScript (endpoint) doit passer par avecErreurs() ;
//   2. zéro catch vide dans le code TypeScript (une erreur avalée = interdit).
// Les 78 fonctions .js legacy (Airtable) gardent withSentry jusqu'à leur portage :
// elles ne sont pas scannées ici, elles disparaissent en Phase 2+.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dossierFonctions = 'netlify/functions';
let erreurs = 0;

function fichiersTs(dossier) {
  return readdirSync(dossier, { withFileTypes: true }).flatMap((e) => {
    const chemin = join(dossier, e.name);
    if (e.isDirectory() && e.name !== 'node_modules') return fichiersTs(chemin);
    if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) return [chemin];
    return [];
  });
}

const tous = fichiersTs(dossierFonctions);
const endpoints = tous.filter((f) => !f.replace(/\\/g, '/').includes('/_lib/'));

for (const fichier of endpoints) {
  const code = readFileSync(fichier, 'utf8');
  if (!/avecErreurs\s*\(/.test(code)) {
    console.error(`ÉCHEC — ${fichier} : fonction sans wrapper avecErreurs() (obligatoire).`);
    erreurs++;
  }
}

for (const fichier of tous) {
  const code = readFileSync(fichier, 'utf8');
  // catch vide (avec ou sans binding), sauf s'il contient un commentaire qui justifie.
  const catchVide = /catch\s*(\([^)]*\))?\s*\{\s*\}/g;
  let m;
  while ((m = catchVide.exec(code)) !== null) {
    console.error(`ÉCHEC — ${fichier} : catch vide interdit (erreur avalée en silence).`);
    erreurs++;
  }
}

if (erreurs > 0) {
  console.error(`\n${erreurs} violation(s) du contrat d'observabilité.`);
  process.exit(1);
}
console.log(`Wrapper vérifié : ${endpoints.length} endpoint(s) TS conformes, zéro catch vide (${tous.length} fichiers TS scannés).`);
