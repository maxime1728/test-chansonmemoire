// netlify/functions/decortique.js
// E/F v1 — Analyse une DEMANDE DE MODIFICATION post-achat et la prépare pour approbation.
// Claude route la demande libre en 5 catégories (paroles / style+ambiance / prononciation /
// souvenirs / titre), produit un compte-rendu + un PROMPT STYLE ajusté (règles dures), et propose
// des paroles ajustées si la demande touche les paroles. Écrit la demande « à approuver » sur le
// Project ; Maxime/Brigitte valident, puis la relance Suno/cover se branchera (couche suivante :
// aller-retour courriel Mailgun + chaîne cover Suno, encore gated).
// Sécurité : POST, UUID v4 strict, formule échappée, gaté `purchased`, secrets en env.

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TOKEN   = process.env.AIRTABLE_TOKEN;
const API     = `https://api.airtable.com/v0/${BASE_ID}`;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Mailgun TRANSACTIONNEL (post-achat). No-op si non configuré (ne casse jamais l'enregistrement).
const MG_KEY     = process.env.MAILGUN_API_KEY;
const MG_DOMAIN  = process.env.MAILGUN_DOMAIN_ACHAT || process.env.MAILGUN_DOMAIN;     // sous-domaine transactionnel (= celui de lancer-cadeau)
const MG_FROM    = process.env.MAILGUN_FROM || 'Chanson Mémoire <info@chansonmemoire.ca>';
const TEAM_EMAIL = process.env.TEAM_NOTIFY_EMAIL;  // destinataire de l'alerte interne « à approuver »

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>'); }

// Courriel Mailgun (HTML). best-effort -> false si non configuré / échec.
async function envoyerCourriel(to, subject, html) {
  if (!MG_KEY || !MG_DOMAIN || !to || !to.includes('@')) return false;
  const form = new FormData();
  form.append('from', MG_FROM);
  form.append('to', to);
  form.append('subject', subject);
  form.append('html', html);
  const auth = 'Basic ' + Buffer.from('api:' + MG_KEY).toString('base64');
  const r = await fetch(`https://api.mailgun.net/v3/${MG_DOMAIN}/messages`, { method: 'POST', headers: { Authorization: auth }, body: form });
  return r.ok;
}

// Courriel de l'acheteur (sur le Client lié) — jamais exposé au navigateur.
async function emailClient(projet, headers) {
  try {
    const link  = projet.fields.Client;
    const recId = Array.isArray(link) ? link[0] : null;
    if (!recId) return '';
    const r = await fetch(`${API}/Clients/${recId}`, { headers });
    if (!r.ok) return '';
    const d = await r.json();
    return (d.fields && d.fields.email) || '';
  } catch (_) { return ''; }
}

const SYSTEM = `Tu prépares une DEMANDE DE MODIFICATION post-achat pour une chanson hommage (Chanson Mémoire, Québec). Tu N'EXÉCUTES pas tout : tu analyses la demande et prépares le travail pour l'équipe.

CATÉGORISE la demande dans une ou plusieurs des 5 catégories EXACTES : "paroles", "style_ambiance", "prononciation", "souvenirs", "titre".

MODE : "cover" par défaut (garde la mélodie existante, ajuste les paroles). "regeneration" UNIQUEMENT si le client veut une autre musique / mélodie / style.

PROMPT STYLE AJUSTÉ (en anglais, directives musicales courtes) — RÈGLES DURES, non négociables :
- JAMAIS de noms d'artistes ni de titres de chansons existantes.
- TOUJOURS inclure "Quebec French accent, Canadian French".
- NE mentionne JAMAIS le genre de la voix ("male voice" / "female voice", "homme", "femme") : la voix est DÉJÀ choisie par le client et gérée séparément (vocalGender Suno). N'inclus rien sur la voix dans le prompt style.
- Ne contredis PAS le style/ambiance existants, sauf demande explicite du client.
- Format : genre, instrumentation, tempo, langue/accent (PAS de voix).

PAROLES AJUSTÉES (en français québécois) — UNIQUEMENT si la demande touche paroles/souvenirs/prononciation :
- Garde TOUT ce qui fonctionne ; applique SEULEMENT la demande. N'invente AUCUN fait, nom ni lieu.
- Sinon, renvoie une chaîne vide "".

VOIX DE MARQUE : solution-first, digne, jamais ouvrir sur le deuil ; pas de clichés.

SORTIE — réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, guillemets droits :
{"categories":["..."],"mode":"cover","compte_rendu":"<résumé clair pour l'équipe, en français>","adjusted_style_prompt":"<prompt style en anglais respectant les règles dures>","adjusted_lyrics":"<paroles ajustées en québécois OU chaîne vide>"}`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: 'Configuration serveur manquante' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token   = (body.token || '').trim();
  const demande = (body.demande || '').toString().trim().slice(0, 4000);
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };
  if (!demande)             return { statusCode: 400, body: JSON.stringify({ error: 'Demande vide' }) };

  const headers = { Authorization: `Bearer ${TOKEN}` };

  try {
    // 1. Project par token (token validé UUID -> littéral sûr).
    const fP = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${fP}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };   // 404 nu
    }
    const projet = dP.records[0];
    const p = projet.fields;
    // Corrections = post-achat uniquement (vérif serveur).
    if (p.commercial_status !== 'purchased') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Non autorisé' }) };
    }

    // 2. Version de référence : la version ACHETÉE si connue, sinon la plus récente.
    const projLit = formulaLiteral(p.project);
    if (projLit === null) return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
    const boughtNo = parseInt(p.purchased_generation_no, 10);
    const fG = Number.isInteger(boughtNo)
      ? encodeURIComponent(`AND({project}=${projLit}, {generation_no}=${boughtNo})`)
      : encodeURIComponent(`{project}=${projLit}`);
    const triG = Number.isInteger(boughtNo) ? '' : '&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=desc';
    const rG = await fetch(`${API}/Generations?filterByFormula=${fG}${triG}&maxRecords=1`, { headers });
    const dG = await rG.json();
    const gen = (dG.records && dG.records[0]) ? dG.records[0].fields : {};

    // 3. Claude : analyse + compte-rendu + prompt style ajusté + paroles ajustées (si pertinent).
    const userPrompt =
`Détails du projet :
- Personne honorée : ${p.deceased_name || ''}
- Style actuel : ${gen.gen_music_style || p.music_style || ''}
- Ambiance actuelle : ${gen.gen_mood || p.mood || ''}
- Voix : ${gen.gen_voice || p.voice || ''}
- Titre actuel : ${gen.song_title || ''}

PAROLES ACTUELLES :
${gen.lyrics || ''}

DEMANDE DU CLIENT (à analyser) :
${demande}`;

    const rC = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 3000, system: SYSTEM, messages: [{ role: 'user', content: userPrompt }] })
    });
    const data = await rC.json();
    if (!rC.ok) return { statusCode: 502, body: JSON.stringify({ error: 'Erreur d’analyse' }) };

    let txt = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    txt = txt.replace(/```json/gi, '').replace(/```/g, '').trim();
    const a = txt.indexOf('{'), z = txt.lastIndexOf('}');
    if (a !== -1 && z !== -1 && z > a) txt = txt.slice(a, z + 1);
    let parsed; try { parsed = JSON.parse(txt); } catch (_) { parsed = null; }
    if (!parsed) return { statusCode: 502, body: JSON.stringify({ error: 'Analyse illisible' }) };

    const categories  = Array.isArray(parsed.categories) ? parsed.categories.join(', ') : '';
    const mode        = (parsed.mode === 'regeneration') ? 'regeneration' : 'cover';
    const compteRendu = (parsed.compte_rendu || '').toString().slice(0, 3000);
    const adjStyle    = (parsed.adjusted_style_prompt || '').toString().slice(0, 2000);
    const adjLyrics   = (parsed.adjusted_lyrics || '').toString().slice(0, 6000);

    // ref_id = [token8·V#] (suivi interne).
    const vno   = gen.generation_no || (Number.isInteger(boughtNo) ? boughtNo : '');
    const refId = `${token.slice(0, 8)}·V${vno}`;

    // 4. Écrit la demande « à approuver » sur le Project (par nom de champ).
    const fields = {
      correction_request:    `CATÉGORIES : ${categories}\n\nDEMANDE CLIENT :\n${demande}\n\nANALYSE :\n${compteRendu}`,
      adjusted_style_prompt: adjStyle,
      adjusted_lyrics:       adjLyrics,
      mode_correction:       mode,
      approval_status:       'pending',
      ref_id:                refId
    };
    const rU = await fetch(`${API}/Projects/${projet.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
    if (!rU.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Enregistrement impossible' }) };
    }

    // 5. Courriels transactionnels (best-effort) — la demande est DÉJÀ enregistrée, ceci ne bloque rien :
    //    (a) alerte interne « à approuver » à l'équipe ; (b) confirmation chaleureuse au client.
    try {
      if (TEAM_EMAIL) {
        const teamHtml =
          `<div style="font-family:Georgia,serif;color:#2E1A28;line-height:1.6;max-width:620px;">` +
          `<h2 style="color:#5C2D4A;margin:0 0 4px;">Demande de modification à approuver</h2>` +
          `<p style="color:#7A6070;margin:0 0 16px;">Réf. ${esc(refId)} · ${esc(categories)} · mode ${esc(mode)}</p>` +
          `<p><strong>Personne honorée :</strong> ${esc(p.deceased_name || '')}<br>` +
          `<strong>Titre actuel :</strong> ${esc(gen.song_title || '')}</p>` +
          `<p><strong>Demande du client :</strong><br>${esc(demande)}</p>` +
          `<p><strong>Analyse :</strong><br>${esc(compteRendu)}</p>` +
          (adjLyrics ? `<p><strong>Paroles ajustées proposées :</strong><br>${esc(adjLyrics)}</p>` : '') +
          (adjStyle ? `<p><strong>Prompt style ajusté :</strong><br>${esc(adjStyle)}</p>` : '') +
          `<p style="color:#7A6070;margin-top:18px;">Pour approuver : passez <code>approval_status</code> à « approved » dans Airtable (projet « ${esc(p.project || '')} »).</p></div>`;
        await envoyerCourriel(TEAM_EMAIL, `À approuver — ${refId} (${categories})`, teamHtml);
      }
      const to = await emailClient(projet, headers);
      const clientHtml =
        `<div style="font-family:Georgia,serif;color:#2E1A28;line-height:1.7;max-width:560px;">` +
        `<p>Votre demande de modification est bien reçue.</p>` +
        `<p>Notre équipe prépare votre nouvelle version avec soin et vous revient très bientôt. Vous n'avez rien à faire d'ici là.</p>` +
        `<p style="color:#7A6070;margin-top:18px;">— L'équipe Chanson Mémoire</p></div>`;
      await envoyerCourriel(to, 'Votre demande de modification est bien reçue', clientHtml);
    } catch (_) { /* les courriels ne bloquent jamais l'enregistrement */ }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
