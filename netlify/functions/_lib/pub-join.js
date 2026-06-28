// _lib/pub-join.js — Jointure Projet <-> Pub par ad_name = utm_content.
// Remplace les scenarios Make « Jointure Pub » et « Jointure Hook ».
//
// Best-effort : on ne lie que si la Pub EXISTE deja (les fiches Pub sont creees par Insights a partir
// de la depense Meta, sur un cycle). Si la Pub n'existe pas encore au moment de la conversion, le Projet
// garde son utm_content et pub-join-cron rattrape le lien des que la Pub apparait. On ne cree JAMAIS de
// Pub « stub » par ad_name : Insights upsert les Pubs par ad_id -> un stub creerait des doublons.

function formulaLiteral(v) {
  const s = String(v);
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;   // contient les deux types de guillemets : injoignable proprement
}

// Retourne l'ID de la Pub dont ad_name = adName, ou null (absente / illisible).
async function trouverPub(API, headers, adName) {
  const lit = formulaLiteral(adName);
  if (lit === null) return null;
  const r = await fetch(`${API}/Pubs?filterByFormula=${encodeURIComponent(`{ad_name}=${lit}`)}&maxRecords=1`, { headers });
  if (!r.ok) return null;
  const rec = (((await r.json()).records) || [])[0];
  return rec ? rec.id : null;
}

// Lie le champ `linkFieldId` du Projet `projectId` a la Pub matchant `adName`.
// Retourne true si lie, false sinon (pas d'adName, Pub absente, ou erreur). Best-effort, ne jette pas.
async function lierPub(API, headers, projectId, adName, linkFieldId) {
  try {
    if (!adName || !projectId) return false;
    const pubId = await trouverPub(API, headers, adName);
    if (!pubId) return false;
    const f = {}; f[linkFieldId] = [pubId];
    const r = await fetch(`${API}/Projects/${projectId}`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: f, typecast: true })
    });
    return r.ok;
  } catch (_) { return false; }
}

module.exports = { trouverPub, lierPub };
