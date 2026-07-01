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
const { envoyerCourriel: mgEnvoyer } = require('./courriel');   // cover = transactionnel -> From + sous-domaine résolus par TYPE (Lot 6)
const SITE      = process.env.SITE_URL || 'https://chansonmemoire.ca';

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

// RÈGLE DE PROMOTION (modèle Generation-level) : faut-il publier une version cover LIVRÉE comme
// nouvelle version active d'un projet ? Post-achat UNIQUEMENT (en pré-achat, lire-projet sert déjà la
// plus récente, donc rien à promouvoir). On ne promeut que vers une version STRICTEMENT plus récente
// (idempotent ; jamais de régression vers une version antérieure). Pur -> testé (tests/cover-promotion.test.js).
function versionPlusRecenteAPublier({ commercialStatus, activeNo, deliveredNo } = {}) {
  if (commercialStatus !== 'purchased') return false;
  const a = parseInt(activeNo, 10);
  const d = parseInt(deliveredNo, 10);
  if (!Number.isInteger(a) || !Number.isInteger(d)) return false;
  return d > a;
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

// Envoi via le wrapper central (_lib/courriel) : POST Mailgun + journalisation Courriels (type 'cover').
async function envoyerCourriel(to, subject, html, projetId) {
  const { ok } = await mgEnvoyer({ to, subject, html, type: 'cover', projetId });
  return ok;
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

// Email « votre nouvelle version est prête » (voix de marque, sans tiret cadratin). Pur -> réutilisé par
// livrerCover (livraison directe) et annoncerVersionPrete (watchdog #19).
function htmlNouvelleVersion(p, site) {
  const lien = p.page_url || ((site || SITE) + '/espace-client?id=' + encodeURIComponent(p.token));
  return `<div style="font-family:Georgia,serif;color:#2E1A28;line-height:1.7;max-width:560px;">` +
    `<p style="font-size:18px;color:#5C2D4A;">Votre nouvelle version est prête.</p>` +
    `<p>On a appliqué votre demande de modification. Écoutez et téléchargez la version mise à jour sur votre page :</p>` +
    `<p style="margin:22px 0;"><a href="${lien}" style="background:#5C2D4A;color:#F5F0EA;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block;">Écouter ma nouvelle version</a></p>` +
    `<p style="color:#7A6070;">Pensez à vérifier vos courriels indésirables si vous ne le voyez pas.</p>` +
    `<p style="color:#7A6070;">L'équipe Chanson Mémoire</p></div>`;
}

// LIVRE un cover terminé : ré-héberge l'audio, passe la Generation cover en audio_generated, bascule la
// version achetée si post-achat, vide les champs cover du Projet, envoie le courriel client. Idempotent
// (le gen passe à audio_generated). Renvoie { ok, generation_no }.
async function livrerCover({ api, headers, projet, coverGen, audioUrl, songId }) {
  const p = projet.fields;
  const g = coverGen.fields || {};
  const newNo = g.generation_no;
  const purchasedNo = parseInt(p.purchased_generation_no, 10);
  // #19 REVUE_AVANT_ENVOI (post-achat) : on LIVRE en `prête` (audio prêt mais NI promu NI annoncé au
  // client). L'équipe revoit dans le cockpit, puis l'envoi de la réponse publie (publierVersionPrete).
  // Flag OFF -> livraison directe (publiée + bascule + courriel), comportement strictement inchangé.
  const revue = process.env.REVUE_AVANT_ENVOI === '1' && Number.isInteger(purchasedNo);
  // Studio A/B (jalon 3c) : une version GÉNÉRÉE AU STUDIO est livrée (audio prêt, écoutable) mais NI promue
  // en `purchased_generation_no` NI annoncée au client, tant que l'équipe ne l'a pas explicitement envoyée
  // (bouton « Envoyer » du cockpit -> offrir_ab). Marqueur transitoire par-projet posé par generer_version,
  // consommé ici. Le flux modif NORMAL (pas de marqueur) reste inchangé (bascule + courriel auto).
  const candidate = !!p.pending_ab_candidate && Number.isInteger(purchasedNo);
  const held = revue || candidate;   // held = audio prêt, mais version NI promue NI annoncée au client

  // 1. Ré-héberge l'audio (permanent). Repli sur l'URL source si Cloudinary échoue.
  const hosted = await rehost(audioUrl, { folder: 'covers', publicId: `cover_${p.token}_${newNo}`, resourceType: 'video' }) || audioUrl;

  // 2. La Generation cover (créée au lancement) passe en audio_generated.
  await fetch(`${api}/${GENERATIONS}/${coverGen.id}`, {
    method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: {
      cloudinary_audio_url: hosted,
      song_id: songId || g.song_id || '',
      generation_status: 'audio_generated',
      incident_status: 'résolu',
      version_status: revue ? 'prête' : 'publiée',
      ...(revue ? { prete_at: new Date().toISOString() } : {})
    } })
  });

  // 3. Ferme la boucle côté Projet (prêt pour un éventuel tour suivant). purchased_generation_no n'est
  //    basculé qu'en POST-achat ; en pré-achat la nouvelle génération devient simplement la plus récente.
  const projPatch = { approval_status: 'published', cover_task_id: null, cover_launched_at: null, pending_cover_style: null };
  // Marqueur A/B consommé à CHAQUE livraison (auto-guérison : un marqueur resté coché sur un cover bloqué
  // ne peut pas « tenir » silencieusement la prochaine modif normale). La décision `candidate` a été lue plus haut.
  projPatch.pending_ab_candidate = false;
  if (Number.isInteger(purchasedNo) && !held) { projPatch.purchased_generation_no = newNo; projPatch.purchased_song_title = g.song_title || ''; }
  await fetch(`${api}/Projects/${projet.id}`, {
    method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: projPatch })
  });

  // 3b. Post-achat : l'ancienne version active devient « remplacée » (le cockpit voit clair quelle
  //     version est en ligne). Best-effort : ne bloque jamais la livraison.
  if (Number.isInteger(purchasedNo) && !held && purchasedNo !== newNo) {
    try {
      const litOld = formulaLiteral(p.project);
      if (litOld !== null) {
        const fOld = encodeURIComponent(`AND({project}=${litOld},{generation_no}=${purchasedNo})`);
        const rOld = await fetch(`${api}/${GENERATIONS}?filterByFormula=${fOld}&maxRecords=1`, { headers });
        const dOld = await rOld.json().catch(() => ({}));
        const oldGen = dOld.records && dOld.records[0];
        if (oldGen) await fetch(`${api}/${GENERATIONS}/${oldGen.id}`, {
          method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { version_status: 'remplacée' } })
        });
      }
    } catch (_) { /* la rétrogradation de l'ancienne version ne bloque jamais */ }
  }

  // 4. Courriel « nouvelle version prête » (best-effort, voix de marque). En REVUE (#19) OU en candidate A/B
  //    (jalon 3c) : PAS d'envoi ici. REVUE -> l'envoi de la réponse publie + annonce ; candidate -> c'est le
  //    bouton « Envoyer » du cockpit (offrir_ab) qui promeut + envoie le courriel de choix au client.
  if (!held) try {
    const to = await emailClient(api, headers, projet);
    const html = htmlNouvelleVersion(p, SITE);
    await envoyerCourriel(to, 'Votre nouvelle version est prête', html, projet.id);
  } catch (_) { /* le courriel ne bloque pas la livraison */ }

  return { ok: true, generation_no: newNo, prete: revue, candidate };
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

// ── STATE-MOVE Lot 4 (modèle Generation-level) ──────────────────────────────────────────────────────
// Une correction PROPOSEE mais pas encore lancée = une Generation `version_status='proposée'`. Elle
// remplace à terme le slot transitoire Projet.adjusted_lyrics. Elle NE porte PAS de generation_status
// (le sentinelle ne surveille que audio_pending) ; lancer-cover la PROMEUT (proposée -> en_production)
// au lancement (Bloc C2). type 'cover' par défaut (mélodie préservée). Pur -> testé.
function champsGenProposee({ projetId, genNo, type = 'cover', lyrics = '', style = '', voice, musicStyle, mood, songTitle, convoId, postPurchase = true } = {}) {
  const fields = {
    project: [projetId],
    generation_no: genNo,
    type: type === 'regeneration' ? 'regeneration' : 'cover',
    version_status: 'proposée',
    post_purchase: !!postPurchase,
    lyrics: String(lyrics || '').slice(0, 6000),
    song_title: songTitle || 'Pour toujours'
  };
  if (style)      fields.gen_style_prompt = style;
  if (musicStyle) fields.gen_music_style  = musicStyle;
  if (mood)       fields.gen_mood         = mood;
  if (voice)      fields.gen_voice        = voice;
  if (convoId)    fields.Conversations    = [convoId];
  return fields;
}

// Generation `proposée` la plus récente d'un projet (idempotence côté appliquer + future consommation
// par lancer-cover en C2). Renvoie le record ({id, fields}) ou null.
async function trouverGenProposee(api, headers, projectPrimary) {
  const lit = formulaLiteral(projectPrimary);
  if (lit === null) return null;
  const f = encodeURIComponent(`AND({project}=${lit}, {version_status}="proposée")`);
  const r = await fetch(`${api}/${GENERATIONS}?filterByFormula=${f}&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=1`, { headers });
  const d = await r.json().catch(() => ({}));
  return (d.records && d.records[0]) || null;
}

// ── #19 REVUE_AVANT_ENVOI : publication différée d'une version `prête` ───────────────────────────────
// Sous revue, livrerCover livre en `prête` (audio prêt mais NI promu NI annoncé). Cette fonction PUBLIE
// la version prête la plus récente d'un projet : Gen -> publiée + version active du Projet, l'ancienne ->
// remplacée. Appelée à l'ENVOI de la réponse (repondre-courriel) ou par le watchdog (délai). Best-effort.
async function publierVersionPrete({ api, headers, projetId }) {
  if (!projetId) return { ok: false };
  const rP = await fetch(`${api}/Projects/${projetId}`, { headers });
  if (!rP.ok) return { ok: false };
  const projet = await rP.json();
  const p = projet.fields || {};
  const projLit = formulaLiteral(p.project);
  if (projLit === null) return { ok: false };
  const f = encodeURIComponent(`AND({project}=${projLit}, {version_status}="prête")`);
  const r = await fetch(`${api}/${GENERATIONS}?filterByFormula=${f}&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=1`, { headers });
  const gen = (((await r.json().catch(() => ({}))).records) || [])[0];
  if (!gen) return { ok: false };
  const g = gen.fields || {};
  const newNo = g.generation_no;
  const oldNo = parseInt(p.purchased_generation_no, 10);

  await fetch(`${api}/${GENERATIONS}/${gen.id}`, {
    method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { version_status: 'publiée' } })
  });
  await fetch(`${api}/Projects/${projet.id}`, {
    method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { purchased_generation_no: newNo, purchased_song_title: g.song_title || '' } })
  });
  if (Number.isInteger(oldNo) && oldNo !== newNo) {
    try {
      const fOld = encodeURIComponent(`AND({project}=${projLit},{generation_no}=${oldNo})`);
      const rOld = await fetch(`${api}/${GENERATIONS}?filterByFormula=${fOld}&maxRecords=1`, { headers });
      const oldGen = (((await rOld.json().catch(() => ({}))).records) || [])[0];
      if (oldGen) await fetch(`${api}/${GENERATIONS}/${oldGen.id}`, {
        method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { version_status: 'remplacée' } })
      });
    } catch (_) { /* la rétrogradation de l'ancienne version ne bloque jamais la publication */ }
  }
  return { ok: true, generation_no: newNo };
}

// #19 watchdog : annonce au client que sa version (auto-publiée après délai) est prête. Best-effort.
async function annoncerVersionPrete({ api, headers, projetId }) {
  if (!projetId) return false;
  try {
    const rP = await fetch(`${api}/Projects/${projetId}`, { headers });
    if (!rP.ok) return false;
    const projet = await rP.json();
    const to = await emailClient(api, headers, projet);
    if (!to) return false;
    return await envoyerCourriel(to, 'Votre nouvelle version est prête', htmlNouvelleVersion(projet.fields || {}, SITE), projet.id);
  } catch (_) { return false; }
}

module.exports = { parseCloudinary, fullAudioUrl, coverGenEnAttente, prochainNo, livrerCover, coverEnVol, versionPlusRecenteAPublier, champsGenProposee, trouverGenProposee, publierVersionPrete, annoncerVersionPrete, htmlNouvelleVersion };
