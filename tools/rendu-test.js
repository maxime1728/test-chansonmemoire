// tools/rendu-test.js
//
// RENDU DE TEST GRATUIT (Shotstack sandbox) de la vidéo « paroles vivantes ».
// Utilise EXACTEMENT le même module de design que la production
// (netlify/functions/_lib/paroles-vivantes-timeline) -> le test reflète le rendu livré.
//
// Pré-requis : une clé Shotstack SANDBOX gratuite (https://dashboard.shotstack.io -> Sandbox -> API Key).
// Lancer (PowerShell) :   $env:SHOTSTACK_API_KEY="votre_cle_sandbox"; node tools/rendu-test.js
// Lancer (bash)       :   SHOTSTACK_API_KEY=votre_cle_sandbox node tools/rendu-test.js
//
// Le script poste l'edit, sonde le rendu, puis imprime l'URL du MP4 (filigrane sandbox = normal).
// Aucune donnée réelle requise : paroles + audio d'exemple intégrés. Node 18+ (fetch natif).

const { buildEditFromLyrics } = require('../netlify/functions/_lib/paroles-vivantes-timeline');

const API_KEY = process.env.SHOTSTACK_API_KEY;
const ENVT    = process.env.SHOTSTACK_ENV || 'stage';          // 'stage' = sandbox gratuit
const BASE    = `https://api.shotstack.io/edit/${ENVT}`;

// Audio d'exemple fourni par Shotstack (toujours accessible). En prod, c'est la chanson Cloudinary signée.
const SAMPLE_AUDIO = 'https://shotstack-assets.s3-ap-southeast-2.amazonaws.com/music/unminus/lit.mp3';

// Paroles d'exemple (avec balises de structure, pour vérifier qu'elles sont bien retirées).
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
    console.error('✗ SHOTSTACK_API_KEY manquante. Crée une clé Sandbox gratuite sur dashboard.shotstack.io.');
    process.exit(1);
  }

  const edit = buildEditFromLyrics({
    titre: 'Pour toujours',
    prenom: 'Joséphine',
    lyrics: SAMPLE_LYRICS,
    alignedWords: [],          // l'exemple n'a pas d'horodatage Suno -> cadence douce (la prod, elle, synchronise)
    audioUrl: SAMPLE_AUDIO,
    resolution: 'hd'
  });

  console.log(`→ Envoi de l'edit au rendu Shotstack (${ENVT})…`);
  const rPost = await fetch(`${BASE}/render`, {
    method: 'POST',
    headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(edit)
  });
  const dPost = await rPost.json();
  const id = dPost && dPost.response && dPost.response.id;
  if (!rPost.ok || !id) {
    console.error('✗ Shotstack a refusé :', JSON.stringify(dPost, null, 2));
    process.exit(1);
  }
  console.log(`  render id = ${id}`);

  // Sonde l'état (~3 min max).
  for (let i = 0; i < 45; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const rGet = await fetch(`${BASE}/render/${id}`, { headers: { 'x-api-key': API_KEY } });
    const dGet = await rGet.json();
    const st = dGet && dGet.response && dGet.response.status;
    process.stdout.write(`  …${st}\n`);
    if (st === 'done') {
      console.log(`\n✓ Vidéo prête :\n${dGet.response.url}\n`);
      return;
    }
    if (st === 'failed') {
      console.error('\n✗ Rendu échoué :', dGet.response.error || JSON.stringify(dGet.response));
      process.exit(1);
    }
  }
  console.error('✗ Délai dépassé — vérifie le dashboard Shotstack.');
  process.exit(1);
}

main().catch(e => { console.error('✗ Erreur :', e.message); process.exit(1); });
