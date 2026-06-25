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

const SYSTEM = `Tu aides l'équipe de Chanson Mémoire à corriger la PRONONCIATION d'un mot qu'un chanteur IA prononce mal dans une chanson (le plus souvent en français québécois). Le client décrit le mot et comment il devrait sonner ; tu produis une correction prête à utiliser.

LE PROBLÈME DE FOND : le chanteur IA lit les paroles avec les règles de lecture du FRANÇAIS. Une réécriture ne fonctionne QUE si, lue à voix haute "à la française", elle donne le bon son. Pièges classiques à éviter :
- "ou" se lit toujours "ou" (comme "loup") -> ne l'emploie JAMAIS pour un autre son.
- "ch" se lit "ch" (comme "chat"), jamais "tch".
- "g" devant e/i se lit "j" ; pour un "g" dur, écris "gu".
- "in/im/un/en" se nasalisent ; un "a"/"e" en finale est souvent muet ou faible.
- Pour le son anglais "watch", écris "watch" ou "ouatch" -> JAMAIS "outch".

MÉTHODE (raisonne avant de répondre) :
1. Établis le SON CIBLE syllabe par syllabe à partir de ce que le client a écrit. S'il donne déjà une graphie, fie-toi à son INTENTION de son, pas forcément à sa graphie exacte.
2. Construis une réécriture qui, lue selon les règles du français, produit ce son. Relis-toi syllabe par syllabe pour vérifier qu'aucun piège ci-dessus ne trahit le son.
3. Rédige une explication COURTE et HUMAINE (l'équipe applique la correction à la main).

EXEMPLES BIEN FAITS :
- "Ghislaine" : l'IA dit "Guis-laine" ; le bon son est "Jis-lène" -> réécriture : "Jislaine".
- "juin" : l'IA chante souvent "joint" ; le bon son est "ju-un" (deux syllabes : "ju" + "un") -> réécriture : "ju-un".

SORTIE — uniquement un objet JSON valide, guillemets droits, rien autour :
{"phonetique":"<réécriture à insérer dans les paroles>","explication":"<le son visé, syllabe par syllabe, en clair pour l'équipe>"}`;

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
  const autre      = (body.autre || '').toString().trim().slice(0, 2000);   // box "Autre chose ?" (erreurs paroles, etc.)
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };
  if (!mot && !autre)       return { statusCode: 400, body: JSON.stringify({ error: 'Demande vide' }) };

  const headers = { Authorization: `Bearer ${TOKEN}` };

  try {
    // 1. Project par token (token validé UUID -> littéral sûr).
    const fP = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${fP}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    const projet = dP.records[0];
    const p = projet.fields;

    // 2. Dernière Generation : contexte pour l'IA + cible où stocker la version phonétique (#12).
    let lyrics = '', genId = '', lyricsPhonExistant = '';
    const projLit = formulaLiteral(p.project);
    if (projLit !== null) {
      const fG = encodeURIComponent(`{project}=${projLit}`);
      const rG = await fetch(`${API}/Generations?filterByFormula=${fG}&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=1`, { headers });
      const dG = await rG.json();
      const g0 = dG.records && dG.records[0];
      if (g0) { genId = g0.id; lyrics = g0.fields.lyrics || ''; lyricsPhonExistant = g0.fields.lyrics_phonetique || ''; }
    }

    // 3. Claude : réécriture phonétique + explication (best-effort ; un échec n'empêche pas l'alerte).
    let phonetique = '', explication = '';
    if (mot) try {
      const userPrompt =
`Personne honorée : ${p.deceased_name || ''}
Langue : ${p.language || 'fr-CA'}

MOT mal prononcé : ${mot}
CE QUE LE CLIENT DÉCRIT : ${indication || '(rien de plus)'}
AUTRE CHOSE SIGNALÉE (paroles, etc.) : ${autre || '(rien)'}

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

    // 3b. #12 — Stocke la version PHONÉTIQUE des paroles sur la dernière Generation (cumulative) :
    //     le mot signalé y est réécrit phonétiquement, mais `lyrics` (affiché au client) reste
    //     intact. Une régé ultérieure (lancer-chanson) enverra CETTE version à Suno. Best-effort.
    if (mot && phonetique && genId) {
      try {
        const base = (lyricsPhonExistant && lyricsPhonExistant.trim()) ? lyricsPhonExistant : lyrics;
        const motEsc = mot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rx = new RegExp('(?<![\\wÀ-ÿ])' + motEsc + '(?![\\wÀ-ÿ])', 'gi');   // limites de mot tolérant les accents
        const nouveau = base.replace(rx, phonetique);
        if (nouveau && nouveau !== base) {
          await fetch(`${API}/Generations/${genId}`, {
            method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: { lyrics_phonetique: nouveau } })
          });
        }
      } catch (_) { /* le stockage phonétique ne bloque jamais l'alerte équipe */ }
    }

    // 3c. #12 — Enregistre une DEMANDE À APPROUVER dans Airtable (trace + workflow approbation -> cover).
    //     Tu approuves (approval_status=approved) -> cover-cron relance lancer-cover, qui utilise la
    //     version phonétique stockée. Mode 'cover' (mélodie préservée). Best-effort.
    try {
      const fields = {
        correction_request: `CATÉGORIE : prononciation\n\nMOT : ${mot || '(voir « autre »)'}\nINDICATION CLIENT : ${indication || '(rien)'}\nAUTRE : ${autre || '(rien)'}\n\nPHONÉTIQUE PROPOSÉE : ${phonetique || '—'}\nANALYSE : ${explication || '—'}`,
        mode_correction: 'cover',
        approval_status: 'pending',
        ref_id: `${token.slice(0, 8)}·PRON`
      };
      await fetch(`${API}/Projects/${projet.id}`, {
        method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields })
      });
    } catch (_) { /* la trace ne bloque jamais la confirmation client */ }

    // 4. Courriel à l'équipe (best-effort) — c'est la sortie principale de cette demande.
    try {
      const to = await emailClient(projet, headers);
      if (TEAM_EMAIL) {
        const html =
          `<div style="font-family:Georgia,serif;color:#2E1A28;line-height:1.6;max-width:620px;">` +
          `<h2 style="color:#5C2D4A;margin:0 0 4px;">Erreur de prononciation signalée</h2>` +
          `<p style="color:#7A6070;margin:0 0 16px;">Personne honorée : ${esc(p.deceased_name || '')}</p>` +
          `<p><strong>Mot à corriger :</strong> ${esc(mot || '(aucun — voir « Autre chose »)')}</p>` +
          `<p><strong>Ce que le client a écrit :</strong><br>${esc(indication || '(rien de plus)')}</p>` +
          `<p><strong>Autre chose à ajouter (paroles, etc.) :</strong><br>${esc(autre || '(rien)')}</p>` +
          `<p><strong>Prononciation proposée (à mettre dans les paroles) :</strong><br>` +
          `<span style="font-size:18px;color:#5C2D4A;"><strong>${esc(phonetique || '— (analyse IA indisponible)')}</strong></span></p>` +
          `<p><strong>Analyse :</strong><br>${esc(explication || '—')}</p>` +
          `<p><strong>Courriel du client :</strong> ${esc(to || '(introuvable)')}</p>` +
          `<p style="margin:20px 0;"><a href="${SITE}/apercu?id=${encodeURIComponent(token)}" style="background:#5C2D4A;color:#F5F0EA;text-decoration:none;padding:11px 20px;border-radius:8px;display:inline-block;">Ouvrir l'aperçu</a></p>` +
          `<p style="color:#7A6070;margin-top:18px;">Régénère la chanson avec la prononciation corrigée, puis renvoie le lien au client.</p></div>`;
        const sujet = mot
          ? `Prononciation à corriger — « ${mot} » (${(p.deceased_name || '').slice(0, 40)})`
          : `Correction demandée (paroles) — ${(p.deceased_name || '').slice(0, 40)}`;
        await envoyerCourriel(TEAM_EMAIL, sujet, html);
      }
    } catch (_) { /* le courriel ne bloque pas la confirmation client */ }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
  }
};
