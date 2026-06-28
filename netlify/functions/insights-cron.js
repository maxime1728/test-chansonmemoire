// insights-cron.js — Pull de la depense Meta -> tables Pubs + Pubs_Performance (remplace le scenario
// Make « Insights » 4796178, qui plante a la run du matin).
//
// Chaque jour : appelle l'API Meta Marketing (insights, niveau ad, time_increment=1), puis upsert :
//   - Pubs               (cle = ad_id)         : 1 ligne par creatif (ad_name/campaign/adset).
//   - Pubs_Performance   (cle = perf_key)      : 1 ligne par creatif x jour (spend/impressions/...).
// Le revenu (ROAS) vient des ventes Airtable, PAS de Meta -> on ne tire ici QUE la diffusion/cout.
//
// ┌─────────────────────────────────────────────────────────────────────────────────────────────┐
// │ ⚠️ PLACEHOLDERS A POSER PAR MAXIME (variables d'env Netlify) — le cron est INERTE sans elles : │
// │   • META_AD_ACCOUNT_ID   = ton compte pub, format « act_1234567890 »  (placeholder ci-dessous) │
// │   • META_MARKETING_TOKEN = token avec scope ads_read (peut etre le meme que META_CAPI_TOKEN    │
// │                            s'il a ads_read ; sinon cree un token dedie).                       │
// │   • (optionnel) INSIGHTS_DATE_PRESET = fenetre Meta, defaut « yesterday » (ou « last_3d »      │
// │                            pour rattraper les conversions tardives).                           │
// └─────────────────────────────────────────────────────────────────────────────────────────────┘
// Quand c'est verifie en prod, ETEINDRE le scenario Make « Insights » (4796178).

const BASE_ID   = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN  = process.env.AIRTABLE_TOKEN;
const API       = `https://api.airtable.com/v0/${BASE_ID}`;

// PLACEHOLDERS Meta (a poser en env Netlify) :
const AD_ACCOUNT = process.env.META_AD_ACCOUNT_ID || '';                 // « act_XXXXXXXXXX »
const MKT_TOKEN  = process.env.META_MARKETING_TOKEN || process.env.META_CAPI_TOKEN || '';
// last_3d = aujourd'hui + 2 jours -> chaque run (horaire) rafraichit la depense du jour en cours
// et rattrape les conversions tardives. Idempotent (upsert par perf_key = ad_id_jour).
const DATE_PRESET= process.env.INSIGHTS_DATE_PRESET || 'last_3d';

const PUBS = 'tblF68heKEIpyMuQW', PERF = 'tblR0fNh6mIoVlC9V';
// IDs de champ Pubs
const PB = { ad_name:'fldlvdQjuYYWxlhsD', ad_id:'fldJI8ZurTPxIueio', campaign:'fldmgh5XfhLdrVc4v', adset:'fldqciP6g79ZLRPt7' };
// IDs de champ Pubs_Performance
const PF = { perf_key:'fldNBdpLuwsYwhbYF', date:'fldBTwsKfhbpXON4b', Pub:'fldrDI60VTBt6aAj4', spend:'fldXVs2VQNgsuxw60',
  impressions:'fldalj4PXhgnqBPAP', reach:'fld0gvMF3eCW2Scpv', frequency:'fldd6BR2yowQs1Zxf', video_3s:'flduOyhr1jjNf0QR5',
  thruplays:'fldwZm1Xdc0ectbHj', avg_watch_sec:'fldqoJqdqWtFK7B95', link_clicks:'fldoe3x79IwzlNIDy',
  outbound_clicks:'fld0cFfjwryQvdaw6', lpv:'fldi9TncnaYBOgnAG' };

// Extrait une valeur d'action Meta (les metriques video/landing sont des tableaux {action_type, value}).
function actionValue(arr, type) {
  if (!Array.isArray(arr)) return 0;
  const hit = arr.find(a => a && a.action_type === type);
  return hit ? Number(hit.value) || 0 : 0;
}

// Upsert Airtable par lots de 10, en fusionnant sur `mergeFieldId`. Retourne les records (avec leur id).
async function upsert(tableId, mergeFieldId, records, headers) {
  const out = [];
  for (let i = 0; i < records.length; i += 10) {
    const lot = records.slice(i, i + 10);
    const r = await fetch(`${API}/${tableId}`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ performUpsert: { fieldsToMergeOn: [mergeFieldId] }, records: lot, typecast: true })
    });
    if (!r.ok) { console.error(`[insights-cron] upsert ${tableId}:`, r.status, (await r.text()).slice(0, 200)); continue; }
    const d = await r.json();
    for (const rec of (d.records || [])) out.push(rec);
  }
  return out;
}

exports.handler = async () => {
  if (!BASE_ID || !AT_TOKEN) return { statusCode: 200, body: 'no-airtable-config' };
  if (!AD_ACCOUNT || !MKT_TOKEN) {
    console.log('[insights-cron] inerte : META_AD_ACCOUNT_ID / META_MARKETING_TOKEN non posees.');
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'meta-env-manquante' }) };
  }
  const headers = { Authorization: `Bearer ${AT_TOKEN}` };

  // 1. Pull Meta insights (niveau ad, par jour). PLACEHOLDER : ajuste `fields` si ta taxonomie Make differe.
  const fields = [
    'ad_id', 'ad_name', 'campaign_name', 'adset_name', 'spend', 'impressions', 'reach', 'frequency',
    'inline_link_clicks', 'outbound_clicks', 'video_3_sec_watched_actions', 'video_thruplay_watched_actions',
    'video_avg_time_watched_actions', 'actions'   // actions -> landing_page_view (lpv)
  ].join(',');
  const url = `https://graph.facebook.com/v21.0/${AD_ACCOUNT}/insights`
    + `?level=ad&time_increment=1&date_preset=${encodeURIComponent(DATE_PRESET)}`
    + `&fields=${encodeURIComponent(fields)}&limit=500&access_token=${encodeURIComponent(MKT_TOKEN)}`;

  let rows = [];
  try {
    let next = url, guard = 0;
    do {
      const r = await fetch(next);
      const d = await r.json();
      if (!r.ok) { console.error('[insights-cron] Meta:', JSON.stringify(d).slice(0, 300)); break; }
      rows = rows.concat(d.data || []);
      next = (d.paging && d.paging.next) || null;
    } while (next && ++guard < 50);
  } catch (e) { console.error('[insights-cron] fetch Meta:', e && e.message); return { statusCode: 200, body: 'meta-fetch-error' }; }

  if (!rows.length) { console.log('[insights-cron] aucune ligne Meta.'); return { statusCode: 200, body: JSON.stringify({ rows: 0 }) }; }

  // 2. Upsert Pubs (par ad_id) -> recupere les record IDs pour lier la perf.
  const pubsById = {};
  const pubRecords = [];
  const seen = {};
  for (const row of rows) {
    if (!row.ad_id || seen[row.ad_id]) continue;
    seen[row.ad_id] = true;
    const f = {};
    f[PB.ad_id] = String(row.ad_id);
    if (row.ad_name)       f[PB.ad_name]  = String(row.ad_name);
    if (row.campaign_name) f[PB.campaign] = String(row.campaign_name);
    if (row.adset_name)    f[PB.adset]    = String(row.adset_name);
    pubRecords.push({ fields: f });
  }
  const pubsUpserted = await upsert(PUBS, PB.ad_id, pubRecords, headers);
  for (const rec of pubsUpserted) { const aid = rec.fields && (rec.fields[PB.ad_id] || rec.fields.ad_id); if (aid) pubsById[String(aid)] = rec.id; }

  // 3. Upsert Pubs_Performance (par perf_key = ad_id_date).
  const perfRecords = rows.map(row => {
    const date = row.date_start;                                  // YYYY-MM-DD (time_increment=1)
    const perfKey = `${row.ad_id}_${date}`;
    const f = {};
    f[PF.perf_key]        = perfKey;
    f[PF.date]            = date;
    f[PF.spend]           = Number(row.spend) || 0;
    f[PF.impressions]     = Number(row.impressions) || 0;
    f[PF.reach]           = Number(row.reach) || 0;
    f[PF.frequency]       = Number(row.frequency) || 0;
    f[PF.link_clicks]     = Number(row.inline_link_clicks) || 0;
    f[PF.outbound_clicks] = actionValue(row.outbound_clicks, 'outbound_click');
    f[PF.video_3s]        = actionValue(row.video_3_sec_watched_actions, 'video_view');
    f[PF.thruplays]       = actionValue(row.video_thruplay_watched_actions, 'video_view');
    f[PF.avg_watch_sec]   = actionValue(row.video_avg_time_watched_actions, 'video_view');
    f[PF.lpv]             = actionValue(row.actions, 'landing_page_view');
    const pubId = pubsById[String(row.ad_id)];
    if (pubId) f[PF.Pub] = [pubId];
    return { fields: f };
  });
  const perfUpserted = await upsert(PERF, PF.perf_key, perfRecords, headers);

  console.log(`[insights-cron] rows=${rows.length} pubs=${pubsUpserted.length} perf=${perfUpserted.length}`);
  return { statusCode: 200, body: JSON.stringify({ rows: rows.length, pubs: pubsUpserted.length, perf: perfUpserted.length }) };
};
