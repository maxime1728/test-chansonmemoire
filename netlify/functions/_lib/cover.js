// netlify/functions/_lib/cover.js
//
// Helpers PARTAGÉS pour les covers (mélodie préservée), pour que la création/livraison soit une SEULE
// source de vérité, utilisée par lancer-cover (lancement), callback-cover (livraison normale) ET
// sentinelle-cron (rescue d'un callback perdu). Modèle Generation-level : la Generation du cover est
// créée DÈS le lancement en `audio_pending` (comme une chanson) -> suivie/relancée/alertée par la
// même machinerie que les chansons (sentinelle_retries, incident_*, alerte-cron 10h).

const crypto = require('crypto');
const { rehost } = require('./cloudinary-rehost');

const GENERATIONS = 'Generations';
const CLD_SECRET  = process.env.CLOUDINARY_API_SECRET;

const MG_KEY    = process.env.MAILGUN_API_KEY;
const MG_DOMAIN = process.env.MAILGUN_DOMAIN_ACHAT || process.env.MAILGUN_DOMAIN;
const MG_FROM   = process.env.MAILGUN_FROM_ACHAT || process.env.MAILGUN_FROM || 'Chanson Mémoire <info@chansonmemoire.ca>';
const SITE      = process.env.SITE_URL || 'https://chansonmemoire.ca';

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

// URL audio Cloudinary COMPLÈTE (signée si 'authenticated') — sert de source à couvrir.
function parseCloudinary(url) {
  const m = /res\.cloudinary\.com\/([^/]+)\/video\/(upload|authenticated)\/(?:s--[^/]+--\/)?(?:v\d+\/)?(.+?)(\.\w+)?$/.exec(url || '');
  return m ? { cloud: m[1], type: m[2], publicId: m[3], ext: m[4] || '' } : null;
}
function fullAudioUrl(stored) {
  const p = parseCloudinary(stored);
  if (!p) return '';
  if (p.type === 'authenticated' && CLD_SECRET) {
    const toSign = p.publicId + p.ext;
    const sig = crypto.createHash('sha1').update(toSign + CLD_SECRET).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 8);
    return `https://res.cloudinary.com/${p.cloud}/video/authenticated/s--${sig}--/${p.publicId}${p.ext}`;
  }
  return `https://res.cloudinary.com/${p.cloud}/video/upload/${p.publicId}${p.ext}`;
}

async function envoyerCourriel(to, subject, html) {
  if (!MG_KEY || !MG_DOMAIN || !to || !to.includes('@')) return false;
  const form = new FormData();
  form.append('from', MG_FROM); form.append('to', to);
  form.append('subject', subject); form.append('html', html);
  const auth = 'Basic ' + Buffer.from('api:' + MG_KEY).toString('base64');
  try { const r = await fetch(`https://api.mailgun.net/v3/${MG_DOMAIN}/messages`, { method: 'POST', headers: { Authorization: auth }, body: form }); return r.ok; }
  catch (_) { return false; }
}
async function emailClient(api, headers, projet) {
  try {
    const recId = Array.isArray(projet.fields.Client) ? projet.fields.Client[0] : null;
    if (!recId) return '';
    const r = await fetch(`${api}/Clients/${recId}`, { headers });
    if (!r.ok) return '';
    const d = await r.json();
    return (d.fields && d.fields.email) || '';
  } catch (_) { return ''; }
}

// Trouve la Generation cover EN ATTENTE (audio_pending) d'un projet, pour la réutiliser (retry) au lieu
// d'en créer une nouvelle à chaque relance. Renvoie le record ({id, fields}) ou null.
async function coverGenEnAttente(api, headers, projectPrimary) {
  const lit = formulaLiteral(projectPrimary);
  if (lit === null) return null;
  const f = encodeURIComponent(`AND({project}=${lit}, {type}="cover", {generation_status}="audio_pending")`);
  const r = await fetch(`${api}/${GENERATIONS}?filterByFormula=${f}&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=1`, { headers });
  const d = await r.json().catch(() => ({}));
  return (d.records && d.records[0]) || null;
}

// generation_no max du projet (+1 = prochain numéro).
async function prochainNo(api, headers, projectPrimary) {
  const lit = formulaLiteral(projectPrimary);
  if (lit === null) return 1;
  const f = encodeURIComponent(`{project}=${lit}`);
  const r = await fetch(`${api}/${GENERATIONS}?filterByFormula=${f}&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=1`, { headers });
  const d = await r.json().catch(() => ({}));
  const max = (d.records && d.records[0] && Number(d.records[0].fields.generation_no)) || 0;
  return max + 1;
}

// LIVRE un cover terminé : ré-héberge l'audio, passe la Generation cover en audio_generated, bascule la
// version achetée si post-achat, vide les champs cover du Projet, envoie le courriel client. Idempotent
// (le gen passe à audio_generated). Renvoie { ok, generation_no }.
async function livrerCover({ api, headers, projet, coverGen, audioUrl, songId }) {
  const p = projet.fields;
  const g = coverGen.fields || {};
  const newNo = g.generation_no;

  // 1. Ré-héberge l'audio (permanent). Repli sur l'URL source si Cloudinary échoue.
  const hosted = await rehost(audioUrl, { folder: 'covers', publicId: `cover_${p.token}_${newNo}`, resourceType: 'video' }) || audioUrl;

  // 2. La Generation cover (créée au lancement) passe en audio_generated.
  await fetch(`${api}/${GENERATIONS}/${coverGen.id}`, {
    method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: {
      cloudinary_audio_url: hosted,
      song_id: songId || g.song_id || '',
      generation_status: 'audio_generated',
      incident_status: 'résolu'
    } })
  });

  // 3. Ferme la boucle côté Projet (prêt pour un éventuel tour suivant). purchased_generation_no n'est
  //    basculé qu'en POST-achat ; en pré-achat la nouvelle génération devient simplement la plus récente.
  const purchasedNo = parseInt(p.purchased_generation_no, 10);
  const projPatch = { approval_status: 'published', cover_task_id: null, cover_launched_at: null, pending_cover_style: null };
  if (Number.isInteger(purchasedNo)) { projPatch.purchased_generation_no = newNo; projPatch.purchased_song_title = g.song_title || ''; }
  await fetch(`${api}/Projects/${projet.id}`, {
    method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: projPatch })
  });

  // 4. Courriel « nouvelle version prête » (best-effort, voix de marque).
  try {
    const to = await emailClient(api, headers, projet);
    const html = `<div style="font-family:Georgia,serif;color:#2E1A28;line-height:1.7;max-width:560px;">` +
      `<p style="font-size:18px;color:#5C2D4A;">Votre nouvelle version est prête.</p>` +
      `<p>On a appliqué votre demande de modification. Écoutez et téléchargez la version mise à jour sur votre page :</p>` +
      `<p style="margin:22px 0;"><a href="${p.page_url || (SITE + '/page-memoire?id=' + encodeURIComponent(p.token))}" style="background:#5C2D4A;color:#F5F0EA;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block;">Écouter ma nouvelle version</a></p>` +
      `<p style="color:#7A6070;">Pensez à vérifier vos courriels indésirables si vous ne le voyez pas.</p>` +
      `<p style="color:#7A6070;">— L'équipe Chanson Mémoire</p></div>`;
    await envoyerCourriel(to, 'Votre nouvelle version est prête', html);
  } catch (_) { /* le courriel ne bloque pas la livraison */ }

  return { ok: true, generation_no: newNo };
}

// Un cover est-il DÉJÀ en vol pour ce projet ? (Generation cover en audio_pending, récente.) Sert de
// garde-fou anti-collision : si oui, on bloque une nouvelle demande au lieu d'écraser la première
// (le slot adjusted_lyrics/cover_task_id du Projet est unique). Borné dans le temps (maxAgeMin) pour
// ne pas verrouiller le client des heures si un cover reste bloqué (la sentinelle/alerte gère ce cas).
async function coverEnVol(api, headers, projectPrimary, maxAgeMin = 15) {
  const lit = formulaLiteral(projectPrimary);
  if (lit === null) return false;
  const f = encodeURIComponent(`AND({project}=${lit}, {type}="cover", {generation_status}="audio_pending", IS_AFTER({created_date}, DATEADD(NOW(),-${maxAgeMin},'minutes')))`);
  try {
    const r = await fetch(`${api}/${GENERATIONS}?filterByFormula=${f}&maxRecords=1`, { headers });
    const d = await r.json().catch(() => ({}));
    return !!(d.records && d.records.length);
  } catch (_) { return false; }   // en cas de doute, on ne bloque pas
}

module.exports = { parseCloudinary, fullAudioUrl, coverGenEnAttente, prochainNo, livrerCover, coverEnVol };
