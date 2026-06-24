// netlify/functions/lancer-signet.js
//
// Génère le SIGNET de commémoration (cadeau) : un marque-page imprimable 2"×7" avec le prénom,
// une phrase choisie (signet_text) et un QR code vers la page de la chanson.
// pdfkit + qrcode (gratuit) -> Cloudinary signé -> écrit signet_url sur le Project.
// Compagnon de lancer-cadeau.js (PDF des paroles). Le Canva a été abandonné (Enterprise, trop cher).
//
// Sécurité : POST, UUID v4, gaté Project 'purchased'. Idempotent (si signet_url déjà là -> renvoie).
// Le texte (prénom/phrase) vient d'Airtable -> jamais de contenu client injecté ailleurs.

const PDFDocument = require('pdfkit');
const QRCode      = require('qrcode');
const crypto      = require('crypto');

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const SITE     = 'https://chansonmemoire.ca';
const UUID_V4  = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CLD_CLOUD  = process.env.CLOUDINARY_CLOUD_NAME;
const CLD_KEY    = process.env.CLOUDINARY_API_KEY;
const CLD_SECRET = process.env.CLOUDINARY_API_SECRET;

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}

// ── Signet 2"×7" (144×504 pt) : papier pâle, prénom serif mauve, filet doré, phrase, QR vers la chanson ──
function genererSignetPdf({ prenom, phrase, qrBuffer }) {
  return new Promise((resolve, reject) => {
    const W = 144, H = 504;   // 2 po × 7 po (72 pt/po)
    const doc = new PDFDocument({ size: [W, H], margins: { top: 26, bottom: 22, left: 14, right: 14 } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.rect(0, 0, W, H).fill('#F5F0EA');

    doc.fillColor('#9A8A96').font('Times-Roman').fontSize(8)
      .text('CHANSON MÉMOIRE', 0, 26, { align: 'center', width: W, characterSpacing: 1.5 });

    doc.fillColor('#7A6070').font('Times-Roman').fontSize(9)
      .text('en mémoire de', 0, 64, { align: 'center', width: W, characterSpacing: 1 });
    doc.fillColor('#5C2D4A').font('Times-Italic').fontSize(19)
      .text(prenom || 'toujours', 8, 78, { align: 'center', width: W - 16 });

    const cx = W / 2, ry = doc.y + 10;
    doc.moveTo(cx - 22, ry).lineTo(cx + 22, ry).lineWidth(1).strokeColor('#C4963A').stroke();

    if (phrase) {
      doc.fillColor('#2E1A28').font('Times-Italic').fontSize(11)
        .text(phrase, 16, ry + 18, { align: 'center', width: W - 32, lineGap: 4 });
    }

    // QR vers la page de la chanson, près du bas.
    const qrSize = 96, qx = (W - qrSize) / 2, qy = H - 154;
    doc.image(qrBuffer, qx, qy, { width: qrSize, height: qrSize });
    doc.fillColor('#7A6070').font('Times-Roman').fontSize(8)
      .text('Scanne pour écouter sa chanson', 8, qy + qrSize + 8, { align: 'center', width: W - 16 });

    doc.fillColor('#9A8A96').font('Times-Roman').fontSize(7)
      .text('chansonmemoire.ca', 0, H - 28, { align: 'center', width: W });

    doc.end();
  });
}

// ── Upload Cloudinary signé (resource image, accepte le PDF) -> secure_url permanent ──
async function uploadCloudinary(buffer, publicId) {
  const ts = Math.floor(Date.now() / 1000);
  const folder = 'signets';
  const toSign = `folder=${folder}&public_id=${publicId}&timestamp=${ts}`;
  const signature = crypto.createHash('sha1').update(toSign + CLD_SECRET).digest('hex');

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/pdf' }), 'signet.pdf');
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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  const token = (body.token || '').trim();
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Token invalide' }) };

  const headers = { Authorization: `Bearer ${AT_TOKEN}` };

  try {
    const fP = encodeURIComponent(`{token}=${formulaLiteral(token)}`);
    const rP = await fetch(`${API}/Projects?filterByFormula=${fP}&maxRecords=1`, { headers });
    const dP = await rP.json();
    if (!dP.records || dP.records.length === 0) return { statusCode: 404, body: JSON.stringify({ error: 'Introuvable' }) };
    const projet = dP.records[0];
    if (projet.fields.commercial_status !== 'purchased') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Réservé après achat' }) };
    }

    // Idempotence : déjà généré.
    if (projet.fields.signet_url) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, signet_url: projet.fields.signet_url, already: true }) };
    }

    const prenom = projet.fields.deceased_name || '';
    const phrase = (projet.fields.signet_text || '').toString().trim() || 'Pour toujours dans nos cœurs.';

    // QR -> page de la chanson (token-routée). Le scan ouvre la page qui joue la chanson.
    const qrBuffer = await QRCode.toBuffer(`${SITE}/page-memoire?id=${token}`, { margin: 1, scale: 6 });

    const pdfBuffer = await genererSignetPdf({ prenom, phrase, qrBuffer });
    const signetUrl = await uploadCloudinary(pdfBuffer, `signet_${token}`);

    await fetch(`${API}/Projects/${projet.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { signet_url: signetUrl, signet_template: 'signet-1' } })
    });

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, signet_url: signetUrl }) };
  } catch (err) {
    console.error('[lancer-signet]', err && err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Génération du signet échouée' }) };
  }
};
