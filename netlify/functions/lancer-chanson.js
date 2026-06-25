// netlify/functions/lancer-chanson.js
//
// Lance la CHANSON (nouvelle mélodie, Suno /generate) — REMPLACE l'appel fragile de MAKE C-gen.
// Le body Suno est construit avec JSON.stringify -> échappement automatique des paroles
// (sauts de ligne, guillemets, balises [Verse]) : fini les bugs « bad control character » /
// formules IML de Make. Appelé par revision (confirmation des paroles) et apercu (« Essayer un
// autre style » sans nouveau souvenir) : POST { token, mode?, post_purchase? }.
//
// Réplique de C-gen : plafond serveur (anti-abus), création de la Generation (audio_pending +
// suno_task_id), passage du Project en funnel_step=song_generating. Le callback Suno continue
// d'aller à MAKE C-cb (rehost Cloudinary + statut audio_generated) : INCHANGÉ.
//
// Écritures Airtable par ID DE CHAMP (copiés du blueprint C-gen) -> immunisé aux renommages.
// Sécurité : POST, UUID v4 strict, formule échappée, secrets en env (SUNO_API_KEY, AIRTABLE_*).

const { styleFor } = require('./_lib/style');
const { compteAvantAchat } = require('./_lib/comptage');

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const UUID_V4  = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SUNO_API_KEY  = process.env.SUNO_API_KEY;
const SUNO_MODEL    = process.env.SUNO_MODEL || 'V5_5';
// Le callback Suno va à MAKE C-cb (livraison audio) — INCHANGÉ. MÊME variable d'env que sentinelle-cron
// (source unique), avec repli sur le webhook C-cb connu.
const SUNO_CALLBACK = process.env.MAKE_CCB_WEBHOOK_URL || 'https://hook.us1.make.com/amlfm9tapjjewz2kec1eirs8oylb812g';

// IDs de champ Generations (copiés du blueprint MAKE C-gen module 10) -> match exact du schéma.
const GEN = {
  project:           'fldzXsnRLrkvPbO6p',
  generation_no:     'fldYQz30pRWwQfnYd',
  type:              'fld0ElSpJMdrMkAJy',
  lyrics:            'fld9q1iqsYSx6iGaI',
  song_title:        'fldlcfIdzfDFaG9EG',
  generation_status: 'fldUnmeYy9Uk4zBDq',
  suno_task_id:      'fldJSTPxdzLNzPPs6',
  post_purchase:     'fldqsaG2QJqefc6LN',
  gen_music_style:   'fldHoOpXerV6rsn5V',
  gen_mood:          'fld4MMXVW7zbF1tfb',
  gen_voice:         'fld8gcBdP0smafuKR'
};
const PROJ_FUNNEL_STEP = 'fldepcYRBoQsGoVkJ';   // Projects.funnel_step

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}
// Rollups/lookups Airtable peuvent revenir en tableau -> on extrait un nombre sûr.
function num(v, d) {
  if (Array.isArray(v)) v = v[0];
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

// Cumul CLIENT des chansons réussies pré-achat (sans rollup) : on additionne le champ
// chansons_reussies_avant de TOUS les projets du client. Le projet courant utilise sa
// valeur FRAÎCHE (freshPre) plutôt que la valeur stockée (qui peut être en retard).
// Best-effort : en cas de pépin réseau on retombe sur freshPre (ne bloque jamais à tort).
async function sommeClientAvant(currentId, p, freshPre, headers) {
  try {
    const link = Array.isArray(p.Client) ? p.Client[0] : null;
    if (!link) return freshPre;
    const rc = await fetch(`${API}/Clients/${link}`, { headers });
    if (!rc.ok) return freshPre;
    const email = (((await rc.json()).fields) || {}).email || '';
    const lit = formulaLiteral(email);
    if (!email || lit === null) return freshPre;
    const rp = await fetch(`${API}/Projects?filterByFormula=${encodeURIComponent(`{Client}=${lit}`)}`, { headers });
    if (!rp.ok) return freshPre;
    const recs = ((await rp.json()).records) || [];
    let sum = 0, seen = false;
    for (const r of recs) {
      if (r.id === currentId) { sum += freshPre; seen = true; }
      else sum += num((r.fields || {}).chansons_reussies_avant, 0);
    }
    if (!seen) sum += freshPre;
    return sum;
  } catch (_) { return freshPre; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };
  if (!SUNO_API_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'Configuration Suno manquante' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token = (body.token || '').trim();
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };
  const mode = (body.mode === 'cover') ? 'cover' : 'song';

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };

  try {
    // 1. Project par token.
    const fP = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${fP}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    const projet = dP.records[0];
    const p = projet.fields;

    // 2. TOUTES les Generations du projet (pour COMPTER en direct ET prendre la dernière).
    const projLit = formulaLiteral(p.project);
    if (projLit === null) return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
    const fG = encodeURIComponent(`{project}=${projLit}`);
    const rG = await fetch(`${API}/Generations?filterByFormula=${fG}&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=desc`, { headers });
    const dG = await rG.json();
    const allGens = (dG.records || []);
    const gen = allGens.length ? allGens[0].fields : {};

    // Compteur EN DIRECT (sans rollup). Une chanson compte SEULEMENT si :
    //   audio Suno LIVRÉ (generation_status=audio_generated)  -> échecs jamais comptés (#6)
    //   ET vraie chanson (song/song_regeneration/cover)        -> paroles jamais comptées (#5)
    //   ET avant achat (post_purchase faux)                    -> post-achat compté ailleurs
    //   ET pas déclenchée par l'équipe (admin_triggered faux)  -> tes relances ne comptent pas (#11)
    const preCount = allGens.reduce((n, r) => n + (compteAvantAchat(r.fields) ? 1 : 0), 0);

    // Stat maintenue PAR LE CODE (ta vue Airtable sans rollup). Écrit seulement si ça change.
    if (num(p.chansons_reussies_avant, -1) !== preCount) {
      try {
        await fetch(`${API}/Projects/${projet.id}`, {
          method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { chansons_reussies_avant: preCount } })
        });
      } catch (_) { /* la stat ne doit jamais bloquer la génération */ }
    }

    // 2b. Plafond serveur (calcul live). Acheté = pas de plafond pré-achat.
    //     Avant achat : max 4 chansons réussies / projet ET max 10·(1+achats) / client.
    if (p.commercial_status !== 'purchased') {
      const purchases   = num(p.client_purchases, 0);
      const clientLimit = 10 * (1 + purchases);
      const clientSum   = await sommeClientAvant(projet.id, p, preCount, headers);
      if (preCount >= 4 || clientSum >= clientLimit) {
        return {
          statusCode: 200, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'plafond', message: "Tu as atteint le maximum de chansons gratuites pour cette demande. Écris-nous et on va t'aider avec plaisir." })
        };
      }
    }

    // Paroles : cover -> paroles ajustées (decortique) si présentes ; sinon -> paroles de la dernière Generation.
    const lyrics = ((mode === 'cover' && p.adjusted_lyrics && p.adjusted_lyrics.trim()) ? p.adjusted_lyrics : (gen.lyrics || '')).trim();
    if (!lyrics) return { statusCode: 409, body: JSON.stringify({ error: 'Paroles introuvables' }) };

    const title       = (gen.song_title || `Pour ${p.deceased_name || 'toi'}`).slice(0, 100);
    const dernierNo   = num(gen.generation_no, 0);
    const vocalGender = /Masculin/i.test(p.voice || '') ? 'm' : 'f';
    const style = (await styleFor({ music_style: p.music_style, mood: p.mood, cadeau: p.song_type === 'cadeau', language: p.language })).slice(0, 1000);
    // 1re chanson du projet = 'song' ; les suivantes = 'song_regeneration' (basé sur le compte live).
    const type  = (mode === 'cover') ? 'cover' : (preCount >= 1 ? 'song_regeneration' : 'song');

    // 4. Suno /generate (NOUVELLE mélodie). JSON.stringify -> échappement auto, zéro bug de body.
    const rS = await fetch('https://api.sunoapi.org/api/v1/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SUNO_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customMode: true,
        instrumental: false,
        model: SUNO_MODEL,
        prompt: lyrics.slice(0, 5000),
        style: style,
        title: title,
        vocalGender: vocalGender,
        callBackUrl: SUNO_CALLBACK
      })
    });
    const dS = await rS.json().catch(() => ({}));
    const taskId = dS && dS.data && dS.data.taskId;
    if (!rS.ok || !taskId) {
      console.error('[lancer-chanson] Suno refusé:', (dS && dS.msg) || `HTTP ${rS.status}`);
      return { statusCode: 502, body: JSON.stringify({ error: 'Lancement de la chanson échoué' }) };
    }

    // 5. Crée la Generation (audio_pending + suno_task_id). C-cb (callback Suno) la complétera.
    const fields = {};
    fields[GEN.project]           = [projet.id];
    fields[GEN.generation_no]     = dernierNo + 1;
    fields[GEN.type]              = type;
    fields[GEN.lyrics]            = lyrics;
    fields[GEN.song_title]        = title;
    fields[GEN.generation_status] = 'audio_pending';
    fields[GEN.suno_task_id]      = String(taskId);
    fields[GEN.post_purchase]     = !!body.post_purchase;
    if (p.music_style) fields[GEN.gen_music_style] = p.music_style;
    if (p.mood)        fields[GEN.gen_mood]        = p.mood;
    if (p.voice)       fields[GEN.gen_voice]       = p.voice;

    const rC = await fetch(`${API}/Generations`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
    if (!rC.ok) {
      const detail = await rC.json().catch(() => ({}));
      console.error('[lancer-chanson] Création Generation échouée:', JSON.stringify(detail).slice(0, 500));
      return { statusCode: 502, body: JSON.stringify({ error: 'Écriture Airtable échouée' }) };
    }

    // 6. Project -> song_generating (best-effort, ne bloque jamais la chanson).
    try {
      const pf = {}; pf[PROJ_FUNNEL_STEP] = 'song_generating';
      await fetch(`${API}/Projects/${projet.id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: pf })
      });
    } catch (_) { /* le suivi de parcours ne doit jamais casser la génération */ }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, pending: true }) };
  } catch (err) {
    console.error('[lancer-chanson]', err && err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
