// pub-join-cron.js — Rattrapage de la jointure Projet <-> Pub (ex-Make « Jointure Pub »).
//
// soumettre-survey (first) et creer-checkout (last) lient deja le Projet a sa Pub en best-effort.
// Mais si la fiche Pub n'existait pas encore a ce moment (Insights tire la depense Meta sur un cycle),
// le lien n'a pas pu se poser. Ce cron repasse periodiquement : pour chaque Projet portant un
// utm_content (first) ou last_utm_content (last) SANS lien Pub correspondant, il pose le lien des que
// la Pub est apparue. Idempotent : ne touche que les liens manquants. Horaire (cadence d'Insights).

const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const { lierPub } = require('./_lib/pub-join');

// IDs de champ (Projects).
const F = {
  utm_content:      'fld717FXmUvBBAahC',   // first-touch utm_content
  last_utm_content: 'fldK7yie7Vc3dqVux',
  Pub:              'flds2b9ClA5MZkeTv',    // lien first-touch
  last_pub:         'fld3BBWOYqlkMYec9'     // lien last-touch
};

function vide(linkVal) { return !(Array.isArray(linkVal) && linkVal.length); }

exports.handler = async () => {
  if (!BASE_ID || !AT_TOKEN) return { statusCode: 200, body: 'no-config' };
  const headers = { Authorization: `Bearer ${AT_TOKEN}` };

  // On scanne les Projets qui ont AU MOINS un utm_content ; la verification « lien manquant » se fait
  // en code (plus robuste qu'un test de champ-lien dans filterByFormula).
  const formula = `OR({utm_content}!='',{last_utm_content}!='')`;
  const qFields = `&fields%5B%5D=${F.utm_content}&fields%5B%5D=${F.last_utm_content}&fields%5B%5D=${F.Pub}&fields%5B%5D=${F.last_pub}`;

  let scanned = 0, linked = 0, offset = null;
  try {
    do {
      let url = `${API}/Projects?filterByFormula=${encodeURIComponent(formula)}&pageSize=100&returnFieldsByFieldId=true${qFields}`;
      if (offset) url += `&offset=${encodeURIComponent(offset)}`;
      const r = await fetch(url, { headers });
      if (!r.ok) { console.error('[pub-join-cron] lecture Projects:', r.status); break; }
      const d = await r.json();
      for (const rec of (d.records || [])) {
        scanned++;
        const f = rec.fields || {};
        if (f[F.utm_content] && vide(f[F.Pub])) {
          if (await lierPub(API, headers, rec.id, f[F.utm_content], F.Pub)) linked++;
        }
        if (f[F.last_utm_content] && vide(f[F.last_pub])) {
          if (await lierPub(API, headers, rec.id, f[F.last_utm_content], F.last_pub)) linked++;
        }
      }
      offset = d.offset || null;
    } while (offset);
  } catch (e) {
    console.error('[pub-join-cron]', e && e.message);
  }

  console.log(`[pub-join-cron] scanned=${scanned} linked=${linked}`);
  return { statusCode: 200, body: JSON.stringify({ scanned, linked }) };
};
