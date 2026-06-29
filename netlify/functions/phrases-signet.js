// netlify/functions/phrases-signet.js
// Propose 3 à 5 courtes phrases pour le SIGNET de commémoration, à partir des DÉTAILS du projet.
// Lecture seule (Project) + 1 appel Anthropic. Voix de marque : SOLUTION-FIRST, digne, jamais
// ouvrir sur le deuil/la perte, jamais inventer. Gaté `purchased`. Secrets en env.

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TOKEN   = process.env.AIRTABLE_TOKEN;
const API     = `https://api.airtable.com/v0/${BASE_ID}`;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

const SYSTEM = `Tu écris de courtes phrases commémoratives en français QUÉBÉCOIS pour un signet (carte) en hommage à une personne décédée.
SOLUTION-FIRST — NON négociable : ne JAMAIS ouvrir sur le deuil, la perte ou la mort. Célébrer QUI était la personne et ce qui reste (une présence, une façon d'être, un souvenir vivant).
TON : digne, sobre, chaleureux ; jamais larmoyant, jamais de clichés ("ange gardien", "étoile", "là-haut"), jamais d'imagerie religieuse.
VÉRITÉ : utiliser UNIQUEMENT les détails fournis. Ne rien inventer (ni nom, ni lieu, ni fait).
FORME : chaque phrase = 4 à 14 mots, évocatrice et autonome.
SORTIE : réponds UNIQUEMENT avec un objet JSON valide, sans texte autour : {"phrases":["...","...","..."]} (3 à 5 phrases).`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: 'Configuration serveur manquante' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token = (body.token || '').trim();
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };

  const headers = { Authorization: `Bearer ${TOKEN}` };

  try {
    const formule = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${formule}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    }
    const p = dP.records[0].fields;
    if (p.commercial_status !== 'purchased') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Non autorisé' }) };
    }

    const userPrompt =
`Personne: ${p.deceased_name || ''}
Relation avec la personne qui commande: ${p.relationship || ''}
Ce qui la rendait unique: ${p.what_made_unique || ''}
Souvenirs partagés: ${p.memories || ''}
À garder et transmettre: ${p.memory_to_keep || ''}`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 600, system: SYSTEM, messages: [{ role: 'user', content: userPrompt }] })
    });
    const data = await r.json();
    if (!r.ok) return { statusCode: 502, body: JSON.stringify({ error: 'Erreur de génération' }) };

    let raw = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    raw = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
    if (a !== -1 && b !== -1 && b > a) raw = raw.slice(a, b + 1);
    let phrases = [];
    try { const parsed = JSON.parse(raw); phrases = Array.isArray(parsed.phrases) ? parsed.phrases : []; } catch (_) {}
    phrases = phrases.filter(x => typeof x === 'string' && x.trim()).slice(0, 5);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phrases })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};

// Observabilite : capture Sentry des exceptions non gerees (inerte sans SENTRY_DSN). Voir _lib/sentry.js.
const { withSentry } = require('./_lib/sentry');
exports.handler = withSentry(exports.handler);
