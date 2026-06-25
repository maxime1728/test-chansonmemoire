// netlify/functions/_lib/ranger.js
//
// #3 — Déplace les assets Cloudinary d'un PROJET ACHETÉ dans le dossier `cm_purchased` et met à
// jour les URLs Airtable (sinon les liens cassent). Couvre : l'audio de TOUTES les Generations du
// projet (chanson achetée + régé/cover post-achat) + les upsells du Projet (instrumentale, vidéo,
// signet, PDF). Idempotent (saute ce qui est déjà dans cm_purchased) et best-effort par asset :
// on ne met à jour l'URL Airtable qu'APRÈS un rename Cloudinary réussi -> jamais de lien cassé.
// cloudinary_range = coché seulement si AUCUN asset n'a échoué (sinon on retentera).

const { rename, parseCloudinaryUrl } = require('./cloudinary-rehost');

const FOLDER = 'cm_purchased';
const GENS   = 'tblfrHFe1zH9apNlp';
const PROJECTS = 'tblh7O8eoog7RyTMJ';
const UPSELL_FIELDS = ['instrumental_url', 'video_url', 'signet_url', 'pdf_url'];

const baseName = (pid) => String(pid).split('/').pop();
function lit(v) { const s = String(v); if (!s.includes('"')) return `"${s}"`; if (!s.includes("'")) return `'${s}'`; return null; }

// Déplace UN asset (par son URL) vers cm_purchased. Renvoie { newUrl } / { already:true } / null (échec).
async function moveAsset(url) {
  const p = parseCloudinaryUrl(url);
  if (!p) return null;
  if (p.publicId.startsWith(FOLDER + '/')) return { already: true };
  const to = `${FOLDER}/${baseName(p.publicId)}`;
  const d = await rename(p.publicId, to, { resourceType: p.resourceType, type: p.type });
  if (!d || !d.secure_url) return null;
  return { newUrl: d.secure_url };
}

// REVERT : remet UN asset de cm_purchased vers la racine (public_id = nom de base). Inverse de moveAsset.
async function moveAssetBack(url) {
  const p = parseCloudinaryUrl(url);
  if (!p) return null;
  if (!p.publicId.startsWith(FOLDER + '/')) return { already: true };   // déjà à la racine
  const to = baseName(p.publicId);
  const d = await rename(p.publicId, to, { resourceType: p.resourceType, type: p.type });
  if (!d || !d.secure_url) return null;
  return { newUrl: d.secure_url };
}

async function rangerProjet(api, headers, projet) {
  const p = projet.fields;
  let moved = 0, skipped = 0, failed = 0;

  // 1. Pour chaque Generation : son audio + ses livrables upsell (PAR VERSION : instrumental/video/signet/pdf).
  try {
    const l = lit(p.project);
    if (l) {
      const r = await fetch(`${api}/${GENS}?filterByFormula=${encodeURIComponent(`{project}=${l}`)}`, { headers });
      const gens = (((await r.json()) || {}).records) || [];
      for (const g of gens) {
        const gp = {};
        // a) Audio de la version.
        const url = g.fields && g.fields.cloudinary_audio_url;
        if (url) {
          const res = await moveAsset(url);
          if (!res) failed++;
          else if (res.already) skipped++;
          else { const np = parseCloudinaryUrl(res.newUrl); gp.cloudinary_audio_url = res.newUrl; if (np) gp.cloudinary_public_id = np.publicId; moved++; }
        }
        // b) Livrables upsell de CETTE version.
        for (const c of UPSELL_FIELDS) {
          if (!g.fields[c]) continue;
          const res = await moveAsset(g.fields[c]);
          if (!res) { failed++; continue; }
          if (res.already) { skipped++; continue; }
          gp[c] = res.newUrl; moved++;
        }
        if (Object.keys(gp).length) {
          await fetch(`${api}/${GENS}/${g.id}`, {
            method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: gp })
          });
        }
      }
    }
  } catch (_) { failed++; }

  // 2. Upsells encore au niveau Projet (LEGACY, données pas encore migrées).
  const patch = {};
  for (const c of UPSELL_FIELDS) {
    if (!p[c]) continue;
    try {
      const res = await moveAsset(p[c]);
      if (!res) { failed++; continue; }
      if (res.already) { skipped++; continue; }
      patch[c] = res.newUrl; moved++;
    } catch (_) { failed++; }
  }
  if (Object.keys(patch).length) {
    await fetch(`${api}/${PROJECTS}/${projet.id}`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: patch })
    });
  }

  // 3. Marque terminé seulement si rien n'a échoué (sinon le prochain passage retentera).
  if (failed === 0) {
    await fetch(`${api}/${PROJECTS}/${projet.id}`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { cloudinary_range: true } })
    });
  }
  return { moved, skipped, failed };
}

// REVERT d'un projet : remet tous ses assets de cm_purchased vers la racine + restaure les URLs
// Airtable + décoche cloudinary_range. Sert à annuler un rangement (ex. la lecture signée casse).
async function rangerRevert(api, headers, projet) {
  const p = projet.fields;
  let moved = 0, skipped = 0, failed = 0;
  try {
    const l = lit(p.project);
    if (l) {
      const r = await fetch(`${api}/${GENS}?filterByFormula=${encodeURIComponent(`{project}=${l}`)}`, { headers });
      const gens = (((await r.json()) || {}).records) || [];
      for (const g of gens) {
        const gp = {};
        const url = g.fields && g.fields.cloudinary_audio_url;
        if (url) {
          const res = await moveAssetBack(url);
          if (!res) failed++;
          else if (res.already) skipped++;
          else { const np = parseCloudinaryUrl(res.newUrl); gp.cloudinary_audio_url = res.newUrl; if (np) gp.cloudinary_public_id = np.publicId; moved++; }
        }
        for (const c of UPSELL_FIELDS) {   // livrables upsell PAR VERSION (revert)
          if (!g.fields[c]) continue;
          const res = await moveAssetBack(g.fields[c]);
          if (!res) { failed++; continue; }
          if (res.already) { skipped++; continue; }
          gp[c] = res.newUrl; moved++;
        }
        if (Object.keys(gp).length) {
          await fetch(`${api}/${GENS}/${g.id}`, {
            method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: gp })
          });
        }
      }
    }
  } catch (_) { failed++; }
  const patch = {};
  for (const c of UPSELL_FIELDS) {
    if (!p[c]) continue;
    try {
      const res = await moveAssetBack(p[c]);
      if (!res) { failed++; continue; }
      if (res.already) { skipped++; continue; }
      patch[c] = res.newUrl; moved++;
    } catch (_) { failed++; }
  }
  patch.cloudinary_range = false;   // toujours décocher : le projet n'est plus rangé
  await fetch(`${api}/${PROJECTS}/${projet.id}`, {
    method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: patch })
  });
  return { moved, skipped, failed };
}

module.exports = { rangerProjet, rangerRevert };
