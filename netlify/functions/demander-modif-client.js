// netlify/functions/demander-modif-client.js
//
// POINT D'ENTRÉE UNIQUE des demandes de modification CLIENT (aperçu, self-serve, token-gaté, sans secret Make).
// Orchestre le routage décidé avec Maxime (voir mémoire cm-point-entree-modif-unifie) à partir d'une demande
// en TEXTE LIBRE : `_lib/analyse-modif` détecte TOUTES les catégories, puis on applique la règle de priorité :
//   1. prononciation détectée n'importe où  -> route 'prononciation' (le navigateur appelle /api/prononciation :
//      Maxime valide la phonétique et applique le reste dans la même passe). La prononciation « gagne » toujours.
//   2. sinon style/ambiance détecté         -> route 'regen'  (nouvelle musique ; le navigateur enchaîne
//      essayer-style + lancer-chanson, qui applique déjà le plafond serveur).
//   3. sinon                                 -> route 'cover'  (mélodie préservée, paroles ajustées) : on écrit
//      adjusted_lyrics + mode_correction='cover' sur le Projet, on pré-remplit une ligne Conversations (file de
//      Maxime), et on renvoie les paroles proposées pour validation client sur /revision.
//
// 3 actions (body.action) :
//   - 'analyser'   : analyse la demande, route, et (route 'cover') écrit/renvoie les paroles proposées.
//   - 'reproposer' : ré-analyse avec une nouvelle consigne (bouton « Régénérer » de /revision en mode cover).
//   - 'lancer'     : le client accepte les paroles -> approval_status='approved' + refaire='Refaire le cover'.
//                    cover-cron (chaque minute) lit refaire et lance lancer-cover (mélodie préservée).
//
// Best-effort sur les traces (Conversations, courriel) : jamais d'exception qui casse la réponse client.
// Sécurité : POST, UUID v4 strict, formule échappée, secrets en env. Aucun effet Suno direct (passe par cover-cron).
// Env : ANTHROPIC_API_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE_ID.

const { analyserModif } = require('./_lib/analyse-modif');
const { styleFor, cataloguePourAmbiance } = require('./_lib/style');
const { coverEnVol } = require('./_lib/cover');

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TOKEN   = process.env.AIRTABLE_TOKEN;
const API     = `https://api.airtable.com/v0/${BASE_ID}`;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CONVOS  = 'tbl3KBgXthCPromxF';   // table Conversations (file de gestion / cockpit Modifications)

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

async function patchProjet(id, fields, headers) {
  return fetch(`${API}/Projects/${id}`, {
    method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ typecast: true, fields })   // typecast : refaire/mode_correction sont des singleSelect
  });
}

// Courriel du prospect (sur le Client lié) — jamais exposé au navigateur, sert à la ligne Conversations.
async function emailClient(projet, headers) {
  try {
    const link = projet.fields.Client;
    const recId = Array.isArray(link) ? link[0] : null;
    if (!recId) return '';
    const r = await fetch(`${API}/Clients/${recId}`, { headers });
    if (!r.ok) return '';
    const d = await r.json();
    return (d.fields && d.fields.email) || '';
  } catch (_) { return ''; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token  = (body.token || '').trim();
  const action = (body.action || 'analyser').toString();
  const texte  = (body.texte || '').toString().trim().slice(0, 4000);
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };

  const headers = { Authorization: `Bearer ${TOKEN}` };

  try {
    // 1. Projet par token (token validé UUID -> littéral sûr).
    const fP = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${fP}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    const projet = dP.records[0];
    const p = projet.fields;

    // GARDE-FOU anti-collision : une seule correction cover EN VOL par projet. Si une version se prépare
    // déjà, on bloque la nouvelle demande (route 'busy') au lieu d'écraser la première (le Projet n'a qu'un
    // slot adjusted_lyrics/cover_task_id). On ne bloque PAS 'reproposer' (mid-flow /revision, pas de lancement).
    const busy = { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, route: 'busy' }) };

    // ── Action 'lancer' : le client a accepté les paroles proposées -> on arme le cover (cover-cron prend le relais).
    if (action === 'lancer') {
      if (await coverEnVol(API, headers, p.project)) return busy;
      await patchProjet(projet.id, { approval_status: 'approved', refaire: 'Refaire le cover', mode_correction: 'cover' }, headers);
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, lancement: true }) };
    }

    if (action === 'analyser' && await coverEnVol(API, headers, p.project)) return busy;

    // 2. Dernière Generation : contexte pour l'analyse + style de référence.
    let gen = {}, genRec = null, lyrics = '';
    const projLit = formulaLiteral(p.project);
    if (projLit !== null) {
      const fG = encodeURIComponent(`{project}=${projLit}`);
      const rG = await fetch(`${API}/Generations?filterByFormula=${fG}&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=1`, { headers });
      genRec = ((((await rG.json()).records) || [])[0]) || null;
      gen = (genRec && genRec.fields) || {};
      lyrics = gen.lyrics || '';
    }

    if (!texte) return { statusCode: 400, body: JSON.stringify({ error: 'Demande vide' }) };

    // 3. Analyse partagée (mêmes garde-fous que decortique / modif-cron) : catégories + paroles ajustées + style.
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const styleActuel = (gen.gen_style_prompt && gen.gen_style_prompt.trim())
      || await styleFor({ music_style: gen.gen_music_style || p.music_style, mood: gen.gen_mood || p.mood, cadeau: p.song_type === 'cadeau', language: p.language });
    const catalogue = await cataloguePourAmbiance({ mood: gen.gen_mood || p.mood, cadeau: p.song_type === 'cadeau', language: p.language });
    const res = await analyserModif({ apiKey, demande: texte, p, gen, styleActuel, catalogue });

    const cats = (res.categories || '').toLowerCase();
    const hasPron  = /prononc/.test(cats);
    const hasStyle = /style|ambiance/.test(cats) || res.mode === 'regeneration';

    // 4. Règle de priorité. (Le navigateur exécute ensuite la route renvoyée.)
    if (hasPron) {
      // La prononciation gagne : on laisse /api/prononciation faire le travail complet (phonétique + alerte).
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, route: 'prononciation' }) };
    }
    if (hasStyle) {
      // Changement de style/ambiance -> régé (nouvelle musique) via le chemin existant (plafond appliqué là-bas).
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, route: 'regen' }) };
    }

    // 5. Route 'cover' : paroles ajustées proposées. On les écrit sur le Projet (lues par lancer-cover) mais on
    //    N'APPROUVE PAS encore : le client valide d'abord sur /revision. Le style reste l'original (cover).
    const adjLyrics = (res.adjLyrics && res.adjLyrics.trim()) || '';
    if (!adjLyrics) {
      // Claude n'a pas su réécrire (demande inexploitable) -> on bascule en prononciation/équipe par prudence.
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, route: 'prononciation' }) };
    }
    await patchProjet(projet.id, { adjusted_lyrics: adjLyrics, mode_correction: 'cover', approval_status: 'pending' }, headers);

    // 6. Ligne Conversations (file de Maxime), pré-remplie pour ne pas être re-traitée par modif-cron. Best-effort.
    if (action === 'analyser') {
      try {
        const to = await emailClient(projet, headers);
        await fetch(`${API}/${CONVOS}`, {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ typecast: true, fields: {
            expediteur:       to || '',
            sujet:            `Modification aperçu${p.deceased_name ? ' : ' + p.deceased_name : ''}`,
            message:          texte,
            recu_le:          new Date().toISOString(),
            statut:           'a_verifier',
            categorie_ia:     'modification',
            paroles_corrigees: adjLyrics,
            modif_pregeneree: true,
            Projet:           [projet.id]
          } })
        });
      } catch (_) { /* la trace ne bloque jamais la réponse client */ }
    }

    return {
      statusCode: 200, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, route: 'cover', lyrics: adjLyrics, titre: gen.song_title || '' })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};

// Observabilite : capture Sentry des exceptions non gerees (inerte sans SENTRY_DSN). Voir _lib/sentry.js.
const { withSentry } = require('./_lib/sentry');
exports.handler = withSentry(exports.handler);
