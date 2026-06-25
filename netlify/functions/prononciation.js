// netlify/functions/prononciation.js
// « Erreur de prononciation » (aperçu, AVANT achat). Le client signale un mot mal prononcé par
// l'IA + (optionnel) comment il devrait sonner. Claude propose une RÉÉCRITURE PHONÉTIQUE + une
// explication, puis un COURRIEL est envoyé à l'équipe (mot + ce que le client a écrit + analyse IA
// + courriel du client + lien aperçu). Maxime régénère manuellement et renvoie le lien (auto plus
// tard). AUCUN effet de bord Suno. Sécurité : POST, UUID v4 strict, formule échappée, secrets en env.

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TOKEN   = process.env.AIRTABLE_TOKEN;
const API     = `https://api.airtable.com/v0/${BASE_ID}`;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Mailgun (transactionnel). No-op si non configuré (ne casse jamais la confirmation client).
const MG_KEY     = process.env.MAILGUN_API_KEY;
const MG_DOMAIN  = process.env.MAILGUN_DOMAIN_ACHAT || process.env.MAILGUN_DOMAIN;
const MG_FROM    = process.env.MAILGUN_FROM || 'Chanson Mémoire <info@chansonmemoire.ca>';
const TEAM_EMAIL = process.env.TEAM_NOTIFY_EMAIL;   // destinataire de l'alerte interne
const SITE       = 'https://chansonmemoire.ca';

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>'); }

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

// Courriel de l'acheteur/prospect (sur le Client lié) — jamais exposé au navigateur.
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

const SYSTEM = `Tu es spécialiste de la prononciation pour le chant en français québécois. Un client signale qu'un MOT de sa chanson (générée par IA) est MAL PRONONCÉ — souvent parce que l'IA le dit "à l'anglaise". À partir du mot et de ce que le client décrit, tu donnes :
1) une RÉÉCRITURE PHONÉTIQUE simple, à insérer telle quelle dans les paroles pour que le chanteur IA le prononce correctement (ex : "Disquatch" -> "diskoutch" ; "Vaughan" -> "Vonne"). Écris-la comme ça se prononce en français courant, sans alphabet phonétique compliqué.
2) une EXPLICATION courte et claire (1-2 phrases) pour l'équipe.
Si le client est vague, fais une hypothèse raisonnable et précise-le dans l'explication.
Réponds UNIQUEMENT avec un objet JSON valide, guillemets droits : {"phonetique":"...","explication":"..."}`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: 'Configuration serveur manquante' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token      = (body.token || '').trim();
  const mot        = (body.mot || '').toString().trim().slice(0, 120);
  const indication = (body.indication || '').toString().trim().slice(0, 1000);
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };
  if (!mot)                 return { statusCode: 400, body: JSON.stringify({ error: 'Mot manquant' }) };

  const headers = { Authorization: `Bearer ${TOKEN}` };

  try {
    // 1. Project par token (token validé UUID -> littéral sûr).
    const fP = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${fP}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    const projet = dP.records[0];
    const p = projet.fields;

    // 2. Paroles de la version la plus récente (contexte pour l'IA).
    let lyrics = '';
    const projLit = formulaLiteral(p.project);
    if (projLit !== null) {
      const fG = encodeURIComponent(`{project}=${projLit}`);
      const rG = await fetch(`${API}/Generations?filterByFormula=${fG}&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=1`, { headers });
      const dG = await rG.json();
      lyrics = (dG.records && dG.records[0] && dG.records[0].fields.lyrics) || '';
    }

    // 3. Claude : réécriture phonétique + explication (best-effort ; un échec n'empêche pas l'alerte).
    let phonetique = '', explication = '';
    try {
      const userPrompt =
`Personne honorée : ${p.deceased_name || ''}
Langue : ${p.language || 'fr-CA'}

MOT mal prononcé : ${mot}
CE QUE LE CLIENT DÉCRIT : ${indication || '(rien de plus)'}

PAROLES (contexte) :
${(lyrics || '').slice(0, 2500)}`;

      const rC = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 800, system: SYSTEM, messages: [{ role: 'user', content: userPrompt }] })
      });
      const data = await rC.json();
      if (rC.ok) {
        let txt = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
        txt = txt.replace(/```json/gi, '').replace(/```/g, '').trim();
        const a = txt.indexOf('{'), z = txt.lastIndexOf('}');
        if (a !== -1 && z !== -1 && z > a) txt = txt.slice(a, z + 1);
        let parsed; try { parsed = JSON.parse(txt); } catch (_) { parsed = null; }
        phonetique  = (parsed && parsed.phonetique  || '').toString().slice(0, 200);
        explication = (parsed && parsed.explication || '').toString().slice(0, 1200);
      }
    } catch (_) { /* analyse best-effort */ }

    // 4. Courriel à l'équipe (best-effort) — c'est la sortie principale de cette demande.
    try {
      const to = await emailClient(projet, headers);
      if (TEAM_EMAIL) {
        const html =
          `<div style="font-family:Georgia,serif;color:#2E1A28;line-height:1.6;max-width:620px;">` +
          `<h2 style="color:#5C2D4A;margin:0 0 4px;">Erreur de prononciation signalée</h2>` +
          `<p style="color:#7A6070;margin:0 0 16px;">Personne honorée : ${esc(p.deceased_name || '')}</p>` +
          `<p><strong>Mot à corriger :</strong> ${esc(mot)}</p>` +
          `<p><strong>Ce que le client a écrit :</strong><br>${esc(indication || '(rien de plus)')}</p>` +
          `<p><strong>Prononciation proposée (à mettre dans les paroles) :</strong><br>` +
          `<span style="font-size:18px;color:#5C2D4A;"><strong>${esc(phonetique || '— (analyse IA indisponible)')}</strong></span></p>` +
          `<p><strong>Analyse :</strong><br>${esc(explication || '—')}</p>` +
          `<p><strong>Courriel du client :</strong> ${esc(to || '(introuvable)')}</p>` +
          `<p style="margin:20px 0;"><a href="${SITE}/apercu?id=${encodeURIComponent(token)}" style="background:#5C2D4A;color:#F5F0EA;text-decoration:none;padding:11px 20px;border-radius:8px;display:inline-block;">Ouvrir l'aperçu</a></p>` +
          `<p style="color:#7A6070;margin-top:18px;">Régénère la chanson avec la prononciation corrigée, puis renvoie le lien au client.</p></div>`;
        await envoyerCourriel(TEAM_EMAIL, `Prononciation à corriger — « ${mot} » (${(p.deceased_name || '').slice(0, 40)})`, html);
      }
    } catch (_) { /* le courriel ne bloque pas la confirmation client */ }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
