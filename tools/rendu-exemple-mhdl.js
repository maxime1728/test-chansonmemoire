// tools/rendu-exemple-mhdl.js
//
// RENDU de la vidéo « paroles vivantes » pour l'EXEMPLE « Mon homme du lac ».
// Réutilise EXACTEMENT le module de design de production
// (netlify/functions/_lib/paroles-vivantes-timeline) -> l'exemple reflète le rendu livré.
//
// Particularités de cet exemple :
//   - Démarre au COUPLET 2 (« comme si c'était le début ») : on ne passe que les paroles
//     à partir du Couplet 2, et on décale l'audio de AUDIO_START secondes (Cloudinary so_).
//   - Pas d'horodatage Suno -> cadence douce (style demo, non synchronisé mot à mot).
//
// Pré-requis : clé API Creatomate (dashboard.creatomate.com -> Project Settings -> API Keys).
//   PowerShell : $env:CREATOMATE_API_KEY="ta_cle"; node tools/rendu-exemple-mhdl.js
//   bash       : CREATOMATE_API_KEY=ta_cle node tools/rendu-exemple-mhdl.js
//
// Le script imprime l'URL du MP4 -> à coller dans exemple-page-memoire.html (VIDEO_URL).
// Option : EXPORT_SCRIPT=1 imprime juste le RenderScript JSON (aucun appel réseau, aucun coût).

const { buildEditFromLyrics } = require('../netlify/functions/_lib/paroles-vivantes-timeline');

const API_KEY = process.env.CREATOMATE_API_KEY;
const VERSION = process.env.CREATOMATE_API_VERSION || 'v1';
const POST_URL = `https://api.creatomate.com/${VERSION}/renders`;

// ── Chanson de l'exemple ──────────────────────────────────────────────────────
const TITRE  = 'Mon homme du lac';
const PRENOM = 'Michel';

// MP3 mixé complet (Cloudinary). AUDIO_START = début du Couplet 2 en secondes (0 = complet).
// Renseigne le timecode du Couplet 2 ici ET dans exemple-page-memoire.html pour qu'ils concordent.
const AUDIO_CLOUD     = 'dcx1tfm47';
const AUDIO_PUBLIC_ID = 'v1782355169/MON_HOMME_DU_LAC_EMOTIONNELLE_lwwoy1.mp3';
const AUDIO_START     = Number(process.env.AUDIO_START || 0);   // ex. 48
function audioUrl() {
  const tf = AUDIO_START > 0 ? `so_${AUDIO_START}/` : '';
  return `https://res.cloudinary.com/${AUDIO_CLOUD}/video/upload/${tf}${AUDIO_PUBLIC_ID}`;
}

// Paroles à partir du Couplet 2. Les balises [..] sont retirées par cleanLyrics (module partagé).
const LYRICS = [
  '[Couplet 2]',
  "Le chalet de Val-des-Bois c'était son royaume à lui",
  "Les fins de semaine d'automne avec les enfants, les amis",
  "Il faisait son bouilli le samedi, ça sentait dans tout le rang",
  "Tout le monde finissait par rentrer, attirés par l'odeur et le temps",
  "Il chantait faux en faisant la vaisselle, il s'en foutait ben raide",
  "Ses blagues plates qu'on connaissait par cœur, on les redemandait",
  "Parce que c'était lui, parce que c'était ça",
  "Michel dans sa cuisine, c'était le plus beau des combats",
  '',
  '[Refrain]',
  "Mon homme du lac, t'as pas fait de bruit en partant",
  "Comme t'avais vécu, discret, généreux, tout doucement",
  "T'es dans le café du matin, t'es dans le bois qui craque",
  "Mon homme du lac, t'es encore là dans chaque escale",
  "Dans les yeux de nos enfants, dans nos dimanches qui flânent",
  "Dans chaque coucher de soleil sur l'eau qui se promène",
  "Mon homme du lac, je t'entends encore rire",
  "T'as pas fini de vivre, t'as juste changé de rive",
  '',
  '[Couplet 3]',
  "Y'avait ces soirs-là où on restait sur le bord de l'eau",
  "Juste toi pis moi, les grenouilles pis les étoiles là-haut",
  "T'avais rien de compliqué à dire, pis c'était parfait",
  "Ces silences-là entre nous deux, ils valaient tout ce qu'on savait",
  "Nos trois enfants ont grandi avec tes mains dans leur chemin",
  "Roxanne, Patrick, Maude, t'étais leur roc, leur matin",
  "Aujourd'hui c'est eux qui portent ça, ce même amour tranquille",
  "Que t'as semé sans compter dans chaque petite île",
  '',
  '[Pont]',
  "J'aurais voulu te dire encore une fois",
  "Que tes matins de pêche, tes bouillons, tes grands bras autour de moi",
  "C'était pas ordinaire, même si on pensait que c'était ordinaire",
  "C'était toute ma vie Michel, c'était toute ma vie entière",
  "Le chalet est encore là, le lac est encore là",
  "Mais c'est plus pareil sans toi dans la chaloupe là-bas",
  "Je prends quand même mon café dehors le matin",
  "Pis je te parle un peu, pis ça fait du bien",
  '',
  '[Refrain]',
  "Mon homme du lac, t'as pas fait de bruit en partant",
  "Comme t'avais vécu, discret, généreux, tout doucement",
  "T'es dans le café du matin, t'es dans le bois qui craque",
  "Mon homme du lac, t'es encore là dans chaque escale",
  "Dans les yeux de nos enfants, dans nos dimanches qui flânent",
  "Dans chaque coucher de soleil sur l'eau qui se promène",
  "Mon homme du lac, je t'entends encore rire",
  "T'as pas fini de vivre, t'as juste changé de rive",
  '',
  '[Outro]',
  "Roxanne, Patrick, Maude, on va garder le chalet",
  "On va garder le bouilli, on va garder ta façon d'aimer",
  "Pis chaque automne quand le lac se calme et que le bois sent bon",
  "On va savoir que t'es là Michel, dans chaque saison"
].join('\n');

function buildScript() {
  return buildEditFromLyrics({
    titre: TITRE,
    prenom: PRENOM,
    lyrics: LYRICS,
    alignedWords: [],          // pas d'horodatage Suno -> cadence douce
    audioUrl: audioUrl()
  });
}

async function main() {
  const edit = buildScript();

  // Mode hors-ligne : imprime le RenderScript sans rien appeler (aucun coût).
  if (process.env.EXPORT_SCRIPT) {
    console.log(JSON.stringify(VERSION === 'v1' ? { source: edit } : edit, null, 2));
    return;
  }

  if (!API_KEY) {
    console.error('✗ CREATOMATE_API_KEY manquante. (Ou lance avec EXPORT_SCRIPT=1 pour juste voir le JSON.)');
    process.exit(1);
  }

  const payload = (VERSION === 'v1') ? { source: edit } : edit;
  console.log(`→ Envoi du RenderScript à Creatomate (${VERSION}) — audio start ${AUDIO_START}s…`);
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
  if (render.status === 'succeeded' && render.url) { console.log(`\n✓ Vidéo prête :\n${render.url}\n`); return; }

  for (let i = 0; i < 60; i++) {
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

module.exports = { buildScript, LYRICS, audioUrl };
main().catch(e => { console.error('✗ Erreur :', e.message); process.exit(1); });
