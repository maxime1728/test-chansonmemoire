// netlify/functions/lancer-cadeau.js
//
// Génère le CADEAU = les paroles de la version achetée en PDF designé (pdfkit, gratuit, 1 modèle),
// le stocke sur Cloudinary, écrit pdf_url sur le Project, et (si Mailgun configuré) envoie un
// courriel avec les PAROLES COMPLÈTES dans le corps + le PDF en pièce jointe.
// Remplace l'ancien scénario Make Cadeaux (Canva = Enterprise, trop cher).
//
// Sécurité : POST, UUID v4, gaté Project 'purchased'. Idempotent (si pdf_url déjà là -> renvoie).
// Le texte (titre/paroles/prénom) vient d'Airtable -> jamais de contenu client non vérifié injecté ailleurs.

const PDFDocument = require('pdfkit');
const crypto = require('crypto');

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const SITE     = 'https://chansonmemoire.ca';
const UUID_V4  = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CLD_CLOUD  = process.env.CLOUDINARY_CLOUD_NAME;
const CLD_KEY    = process.env.CLOUDINARY_API_KEY;
const CLD_SECRET = process.env.CLOUDINARY_API_SECRET;

const MG_KEY    = process.env.MAILGUN_API_KEY;       // no-op si absent (Mailgun en cours de config)
const MG_DOMAIN = process.env.MAILGUN_DOMAIN;
const MG_FROM   = process.env.MAILGUN_FROM || 'Chanson Mémoire <cadeau@chansonmemoire.ca>';

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

// ── PDF designé (papier pâle, titre serif mauve, « en mémoire de », filet doré, paroles centrées) ──
// v1 = polices serif intégrées à pdfkit (Times). Finition : embarquer Cormorant/Fraunces exactes.
function genererPdf({ titre, paroles, prenom }) {
  return new Promise((resolve, reject) => {
    const W = 595.28, H = 841.89;   // A4 portrait (points)
    const doc = new PDFDocument({ size: 'A4', autoFirstPage: false,
      margins: { top: 92, bottom: 76, left: 70, right: 70 } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Fond papier + pied de page sur CHAQUE page (la pagination des paroles longues est automatique).
    doc.on('pageAdded', () => {
      doc.save();
      doc.rect(0, 0, W, H).fill('#F5F0EA');
      doc.fillColor('#9A8A96').font('Times-Roman').fontSize(10)
        .text('Chanson Mémoire', 0, H - 52, { align: 'center', width: W });
      doc.restore();
      doc.x = doc.page.margins.left;
      doc.y = doc.page.margins.top;
    });

    doc.addPage();

    doc.fillColor('#5C2D4A').font('Times-Italic').fontSize(27)
      .text(titre || 'Pour toujours', { align: 'center' });
    doc.moveDown(0.5);

    if (prenom) {
      doc.fillColor('#7A6070').font('Times-Roman').fontSize(11)
        .text('en mémoire de ' + prenom, { align: 'center', characterSpacing: 1.2 });
      doc.moveDown(0.8);
    }

    const cx = W / 2, y = doc.y;
    doc.moveTo(cx - 26, y).lineTo(cx + 26, y).lineWidth(1).strokeColor('#C4963A').stroke();
    doc.moveDown(1.2);

    doc.fillColor('#2E1A28').font('Times-Roman').fontSize(13)
      .text(paroles || '', { align: 'center', lineGap: 6 });

    doc.end();
  });
}

// ── Upload Cloudinary signé (resource image, accepte le PDF) -> secure_url permanent ──
async function uploadCloudinary(buffer, publicId) {
  const ts = Math.floor(Date.now() / 1000);
  const folder = 'cadeaux';
  const toSign = `folder=${folder}&public_id=${publicId}&timestamp=${ts}`;
  const signature = crypto.createHash('sha1').update(toSign + CLD_SECRET).digest('hex');

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/pdf' }), 'paroles.pdf');
  form.append('api_key', CLD_KEY);
  form.append('timestamp', String(ts));
  form.append('public_id', publicId);
  form.append('folder', folder);
  form.append('signature', signature);

  const r = await fetch(`https://api.cloudinary.com/v1_1/${CLD_CLOUD}/image/upload`, { method: 'POST', body: form });
  const d = await r.json();
  if (!r.ok || !d.secure_url) throw new Error('Cloudinary: ' + (d.error && d.error.message || r.status));
  return d.secure_url;
}

async function emailOf(projet, headers) {
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

// ── Courriel Mailgun : paroles complètes (corps) + PDF en pièce jointe. No-op si Mailgun absent. ──
async function envoyerCourriel(to, titre, paroles, pdfBuffer) {
  if (!MG_KEY || !MG_DOMAIN || !to || !to.includes('@')) return false;
  const parolesHtml = String(paroles || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
  const html =
    `<div style="font-family:Georgia,serif;color:#2E1A28;line-height:1.7;max-width:560px;">` +
    `<p>Voici les paroles de <strong>${titre || 'votre chanson'}</strong> — en pièce jointe, une belle feuille en PDF à imprimer ou à garder.</p>` +
    `<hr style="border:none;border-top:1px solid #E5DAE0;margin:18px 0;">` +
    `<div style="white-space:normal;color:#3a2a34;">${parolesHtml}</div>` +
    `<p style="margin-top:22px;color:#7A6070;">Elle vous appartient — gardez-la précieusement.<br>— L'équipe Chanson Mémoire</p></div>`;

  const form = new FormData();
  form.append('from', MG_FROM);
  form.append('to', to);
  form.append('subject', 'Les paroles de ' + (titre || 'votre chanson'));
  form.append('html', html);
  form.append('attachment', new Blob([pdfBuffer], { type: 'application/pdf' }), 'paroles.pdf');

  const auth = 'Basic ' + Buffer.from('api:' + MG_KEY).toString('base64');
  const r = await fetch(`https://api.mailgun.net/v3/${MG_DOMAIN}/messages`, {
    method: 'POST', headers: { Authorization: auth }, body: form
  });
  return r.ok;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token = (body.token || '').trim();
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };

  try {
    // Project par token — doit être acheté.
    const fP = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${fP}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    const projet = dP.records[0];
    if (projet.fields.commercial_status !== 'purchased') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Réservé après achat' }) };
    }

    // Idempotence : déjà généré.
    if (projet.fields.pdf_url) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, pdf_url: projet.fields.pdf_url, already: true }) };
    }

    // Version achetée -> ses paroles + titre.
    const purchasedNo = parseInt(projet.fields.purchased_generation_no, 10);
    if (!Number.isInteger(purchasedNo)) return { statusCode: 409, body: JSON.stringify({ error: 'Version achetée inconnue' }) };
    const projLit = formulaLiteral(projet.fields.project);
    if (projLit === null) return { statusCode: 500, body: JSON.stringify({ error: 'Erreur serveur' }) };
    const fG = encodeURIComponent(`AND({project}=${projLit},{generation_no}=${purchasedNo})`);
    const rG = await fetch(`${API}/Generations?filterByFormula=${fG}&maxRecords=1`, { headers });
    const dG = await rG.json();
    const gen = dG.records && dG.records[0];
    if (!gen || !gen.fields.lyrics) return { statusCode: 409, body: JSON.stringify({ error: 'Paroles introuvables' }) };

    const titre   = gen.fields.song_title || '';
    const paroles = gen.fields.lyrics || '';
    const prenom  = projet.fields.deceased_name || '';

    // 1. PDF -> 2. Cloudinary -> 3. Airtable (pdf_url + marqueur pdf_template).
    const pdfBuffer = await genererPdf({ titre, paroles, prenom });
    const pdfUrl = await uploadCloudinary(pdfBuffer, `paroles_${token}`);

    await fetch(`${API}/Projects/${projet.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { pdf_url: pdfUrl, pdf_template: 'pdf-1' } })
    });

    // 4. Courriel (paroles + PDF) — best-effort, ne bloque pas la réponse si Mailgun pas prêt.
    try {
      const to = await emailOf(projet, headers);
      await envoyerCourriel(to, titre, paroles, pdfBuffer);
    } catch (_) { /* le courriel ne casse jamais la livraison */ }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, pdf_url: pdfUrl }) };
  } catch (err) {
    console.error('[lancer-cadeau]', err && err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Génération du cadeau échouée' }) };
  }
};
