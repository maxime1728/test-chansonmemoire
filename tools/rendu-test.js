// tools/rendu-test.js
//
// RENDU DE TEST de la vidéo « paroles vivantes » via Creatomate (essai gratuit).
// Utilise EXACTEMENT le même module de design que la production
// (netlify/functions/_lib/paroles-vivantes-timeline) -> le test reflète le rendu livré.
//
// Pré-requis : une clé API Creatomate (dashboard.creatomate.com -> Project Settings -> API Keys).
// Lancer (PowerShell) :   $env:CREATOMATE_API_KEY="votre_cle"; node tools/rendu-test.js
// Lancer (bash)       :   CREATOMATE_API_KEY=votre_cle node tools/rendu-test.js
//
// Le script poste le RenderScript, sonde le rendu, puis imprime l'URL du MP4.
// Aucune donnée réelle requise : paroles + audio d'exemple intégrés. Node 18+ (fetch natif).

const { buildEditFromLyrics } = require('../netlify/functions/_lib/paroles-vivantes-timeline');

const API_KEY = process.env.CREATOMATE_API_KEY;
const VERSION = process.env.CREATOMATE_API_VERSION || 'v1';   // doit refléter la prod (lancer-paroles-vivantes)
const POST_URL = `https://api.creatomate.com/${VERSION}/renders`;

// Audio d'exemple public (toujours accessible). En prod, c'est la chanson Cloudinary signée.
const SAMPLE_AUDIO = 'https://shotstack-assets.s3-ap-southeast-2.amazonaws.com/music/unminus/lit.mp3';

const SAMPLE_LYRICS = [
  '[Couplet 1]',
  'Dans la lumière douce du matin',
  'Je revois ton sourire, ta main',
  'Les étés au chalet, les chansons',
  'Et ton rire qui portait nos saisons',
  '',
  '[Refrain]',
  'Tu vis encore dans chaque mélodie',
  'Dans chaque mot que le vent nous confie',
  'Pour toujours, gravée dans nos cœurs',
  'Ta mémoire est notre douceur'
].join('\n');

async function main() {
  if (!API_KEY) {
    console.error('✗ CREATOMATE_API_KEY manquante. Récupère-la dans dashboard.creatomate.com (Project Settings → API Keys).');
    process.exit(1);
  }

  const edit = buildEditFromLyrics({
    titre: 'Pour toujours',
    prenom: 'Joséphine',
    lyrics: SAMPLE_LYRICS,
    alignedWords: [],          // l'exemple n'a pas d'horodatage Suno -> cadence douce (la prod, elle, synchronise)
    audioUrl: SAMPLE_AUDIO
  });

  // v1 attend { source: <RenderScript> } ; v2 prend le RenderScript au top-level.
  const payload = (VERSION === 'v1') ? { source: edit } : edit;

  console.log(`→ Envoi du RenderScript à Creatomate (${VERSION})…`);
  const rPost = await fetch(POST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const dPost = await rPost.json();
  const render = Array.isArray(dPost) ? dPost[0] : dPost;
  const id = render && render.id;
  if (!rPost.ok || !id) {
    console.error('✗ Creatomate a refusé :', JSON.stringify(dPost, null, 2));
    process.exit(1);
  }
  console.log(`  render id = ${id}  (statut ${render.status})`);
  if (render.status === 'succeeded' && render.url) {   // parfois synchrone
    console.log(`\n✓ Vidéo prête :\n${render.url}\n`); return;
  }

  // Sonde l'état (~3 min max).
  for (let i = 0; i < 45; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const rGet = await fetch(`https://api.creatomate.com/v1/renders/${id}`, { headers: { Authorization: `Bearer ${API_KEY}` } });
    const dGet = await rGet.json();
    const st = dGet && dGet.status;
    process.stdout.write(`  …${st}\n`);
    if (st === 'succeeded') { console.log(`\n✓ Vidéo prête :\n${dGet.url}\n`); return; }
    if (st === 'failed')    { console.error('\n✗ Rendu échoué :', dGet.error || JSON.stringify(dGet)); process.exit(1); }
  }
  console.error('✗ Délai dépassé — vérifie le dashboard Creatomate.');
  process.exit(1);
}

main().catch(e => { console.error('✗ Erreur :', e.message); process.exit(1); });
