// netlify/functions/soumettre-survey.js
//
// PROXY de soumission du sondage -> webhook MAKE A. But : ANTI-BOT + robustesse JSON.
//   1. L'URL réelle du webhook Make reste en variable d'env serveur (MAKE_A_WEBHOOK_URL),
//      JAMAIS exposée dans le JS client -> les bots ne peuvent plus la trouver/spammer.
//   2. On exige un token UUID v4 (que seul le vrai formulaire génère) -> le garbage des bots
//      est rejeté ICI (400) et n'atteint jamais Make -> fini les erreurs « Bad control character ».
//   3. On neutralise TOUS les caractères de contrôle + guillemets/antislashs côté serveur
//      (le client le fait déjà ; ceinture + bretelles) -> le JSON reconstruit à la main par
//      Make A (module 5) ne casse plus jamais.
//
// Repli : si MAKE_A_WEBHOOK_URL n'est pas encore posée, on utilise l'URL actuelle -> déploiement
// sans coupure. Après rotation de l'URL (anti-bot), poser MAKE_A_WEBHOOK_URL = nouvelle URL.

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CTRL    = /[\x00-\x1F\x7F]+/g;   // caractères de contrôle ASCII -> remplacés par une espace
const MAKE_A_URL = process.env.MAKE_A_WEBHOOK_URL || 'https://hook.us1.make.com/0o1i2ga73ibmf43ast3wxjikxy56i3n8';

// ── Mode DIRECT (SURVEY_DIRECT=1) : REMPLACE MAKE A — on écrit nous-mêmes dans Airtable. ──
const BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const API      = `https://api.airtable.com/v0/${BASE_ID}`;
const SITE     = 'https://chansonmemoire.ca';
const GEN_SECRET = process.env.GENERATE_LYRICS_SECRET || '';
const CLIENTS = 'tblQbF1OlE3uRxFra', PROJECTS = 'tblh7O8eoog7RyTMJ', GENS = 'tblfrHFe1zH9apNlp';
// IDs de champ copiés du blueprint MAKE A -> immunisé aux renommages.
const CL = { email:'flds762OXVwiSORrZ', consent_status:'fldHrKcSlZGEpbiqc', consent_date:'fldMS8vhM9hMXBkOW', first_contact:'fldkS8Tnbo1b5sQuU', last_activity:'flduovxyibPoAdIyJ' };
const P  = { token:'fldqBcPOplqI7pmTh', Client:'fldAGBhUTrR92bj9a', deceased_name:'fldKuvHVlbPByevNw', Relationship:'fld6sRU6B4gyCvDcV', music_style:'fldyN8cSNrud5PTqW', voice:'fld2ll76GVBTwlrii', mood:'fldo65IejcTOJ6Rgj', language:'fldjXJvehP7DguRdB', song_type:'fldZ5BLAu7eAUhBH6', what_made_unique:'flduGHNsYUGFVJPpW', memories:'flduEXUksZuTGkLCH', memory_to_keep:'fldFZZyQN8I91uRIg', commercial_status:'fldLFpeLNHU0ewF7A', funnel_step:'fldepcYRBoQsGoVkJ', cgv:'fldS53tPp8cmA6hUP', utm_source:'flddBuQWS7VDEQ6Tf', utm_medium:'fldoyM5VqCWvuHupH', utm_campaign:'fldM7MOvA9JSB4TIy', utm_content:'fld717FXmUvBBAahC', utm_term:'fldHS6EXLgJ8xS2hq', fbclid:'fldACzVAZnXIg8Y6F', fbc:'fldH7NqGl1x4iYNUT', fbp:'fldUTYL1ECRDz6ZZ7', landing_page:'fldBCASJabBdbQzf6',
  // Attribution : utm_* + landing_page ci-dessus = FIRST-touch. Bloc LAST-touch + horodatages :
  first_touch_at:'fldmkjQbhTcEQgFVA', last_utm_source:'fldAs0LwECqTSxOgF', last_utm_medium:'fld8e6vKwG3lI74Yq', last_utm_campaign:'fldsifC3yx55b561h', last_utm_content:'fldK7yie7Vc3dqVux', last_utm_term:'fldhcXo9zrM34STzG', last_touch_at:'fldMUwpw5ivyjXggZ', last_landing_page:'fldZQdydtpwXKCxyu',
  Pub:'flds2b9ClA5MZkeTv', last_pub:'fld3BBWOYqlkMYec9' };
const G  = { project:'fldzXsnRLrkvPbO6p', generation_no:'fldYQz30pRWwQfnYd', type:'fld0ElSpJMdrMkAJy', lyrics:'fld9q1iqsYSx6iGaI', song_title:'fldlcfIdzfDFaG9EG', suggestions:'fldmxQuzUg8iALDGF', generation_status:'fldUnmeYy9Uk4zBDq' };
const { lierPub } = require('./_lib/pub-join');   // jointure Projet<->Pub en code (ex-Make « Jointure Pub »)
const { withSentry } = require('./_lib/sentry');  // capture des exceptions non gerees
function formulaLiteral(v) { const s = String(v); if (!s.includes('"')) return `"${s}"`; if (!s.includes("'")) return `'${s}'`; return null; }

function nettoyer(v) {
  if (typeof v !== 'string') return v;
  return v.replace(CTRL, ' ').replace(/[\\"]/g, "'").trim();
}

async function creerGeneration(headers, projetId, no, type, lyr) {
  const f = {};
  f[G.project] = [projetId]; f[G.generation_no] = no; f[G.type] = type;
  f[G.lyrics] = lyr.lyrics; f[G.song_title] = lyr.title || ''; f[G.generation_status] = 'lyrics_generated';
  if (lyr.suggestions) f[G.suggestions] = (typeof lyr.suggestions === 'string') ? lyr.suggestions : JSON.stringify(lyr.suggestions);
  await fetch(`${API}/${GENS}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: f, typecast: true }) });
}
async function dernierNo(headers, projetPrimary) {
  const lit = formulaLiteral(projetPrimary); if (lit === null) return 0;
  const r = await fetch(`${API}/${GENS}?filterByFormula=${encodeURIComponent(`{project}=${lit}`)}&sort%5B0%5D%5Bfield%5D=generation_no&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=1`, { headers });
  if (!r.ok) return 0;
  const g = (((await r.json()).records) || [])[0];
  return (g && Number(g.fields.generation_no)) || 0;
}

// REMPLACE MAKE A : Client (upsert par courriel) + Project (si nouveau token) + Generation, via generate-lyrics.
async function traiterDirect(propre, headers) {
  const token = propre.token;
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  // 1. Client (upsert par courriel) — conserve consent_date / first_contact existants.
  let clientId = '';
  // .toLowerCase() : l'email est la cle d'unicite du client. La recherche Airtable {email}=lit est
  // sensible a la casse, donc Jean@x.com puis jean@x.com creeraient 2 fiches. On normalise en
  // minuscules a la recherche ET au stockage -> 1 seul client par adresse, quelle que soit la casse saisie.
  const email = (propre.email || '').trim().toLowerCase();
  if (email) {
    const lit = formulaLiteral(email);
    let existing = null;
    // returnFieldsByFieldId=true : on relit le client existant avec des clés en ID de champ,
    // sinon existing.fields[CL.consent_date]/[CL.first_contact] (clés = IDs) ne matchent jamais
    // (Airtable renvoie par NOM par défaut) -> consent_date/first_contact écrasés à today à chaque resoumission.
    if (lit) { const r = await fetch(`${API}/${CLIENTS}?filterByFormula=${encodeURIComponent(`{email}=${lit}`)}&maxRecords=1&returnFieldsByFieldId=true`, { headers }); if (r.ok) existing = (((await r.json()).records) || [])[0] || null; }
    const cf = {};
    cf[CL.email] = email; cf[CL.consent_status] = 'received';
    cf[CL.consent_date] = (existing && existing.fields[CL.consent_date]) || today;
    cf[CL.first_contact] = (existing && existing.fields[CL.first_contact]) || today;
    cf[CL.last_activity] = now;
    if (existing) { clientId = existing.id; try { await fetch(`${API}/${CLIENTS}/${clientId}`, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: cf }) }); } catch (_) {} }
    else { const rc = await fetch(`${API}/${CLIENTS}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: cf, typecast: true }) }); if (rc.ok) clientId = (await rc.json()).id; }
  }

  // 2. Projet déjà existant ? (régénération = même token)
  let projet = null;
  const litT = formulaLiteral(token);
  if (litT) { const r = await fetch(`${API}/${PROJECTS}?filterByFormula=${encodeURIComponent(`{token}=${litT}`)}&maxRecords=1`, { headers }); if (r.ok) projet = (((await r.json()).records) || [])[0] || null; }

  // 3. Paroles (generate-lyrics). Échec -> on crée quand même le Projet (revision pourra réessayer).
  let lyr = null;
  try {
    const rl = await fetch(`${SITE}/api/generate-lyrics`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: GEN_SECRET, deceased_name: propre.deceased_name, relationship: propre.relationship, music_style: propre.music_style, mood: propre.mood, what_made_unique: propre.what_made_unique, memories: propre.memories, memory_to_keep: propre.memory_to_keep, language: propre.language, song_type: propre.song_type })
    });
    const dl = await rl.json().catch(() => ({}));
    if (rl.ok && dl && dl.lyrics) lyr = dl;
  } catch (_) {}

  // 4. Nouveau projet -> create Project (toujours) + Generation (si paroles). Sinon -> nouvelle Generation.
  if (!projet) {
    const pf = {};
    pf[P.token] = token; if (clientId) pf[P.Client] = [clientId];
    pf[P.deceased_name] = propre.deceased_name; pf[P.Relationship] = propre.relationship;
    pf[P.music_style] = propre.music_style; pf[P.voice] = propre.voice; pf[P.mood] = propre.mood;
    pf[P.language] = propre.language || 'fr-CA'; pf[P.song_type] = propre.song_type || 'hommage';
    pf[P.what_made_unique] = propre.what_made_unique; pf[P.memories] = propre.memories; pf[P.memory_to_keep] = propre.memory_to_keep;
    pf[P.commercial_status] = 'preview_only'; pf[P.funnel_step] = 'lyrics_generated'; pf[P.cgv] = now;
    pf[P.utm_source] = propre.utm_source; pf[P.utm_medium] = propre.utm_medium; pf[P.utm_campaign] = propre.utm_campaign;
    pf[P.utm_content] = propre.utm_content; pf[P.utm_term] = propre.utm_term; pf[P.fbclid] = propre.fbclid;
    pf[P.fbc] = propre.fbc; pf[P.fbp] = propre.fbp; pf[P.landing_page] = propre.landing_page;
    // LAST-touch (dernier creatif vu) : bloc distinct du first-touch (utm_* ci-dessus).
    pf[P.last_utm_source] = propre.last_utm_source; pf[P.last_utm_medium] = propre.last_utm_medium; pf[P.last_utm_campaign] = propre.last_utm_campaign;
    pf[P.last_utm_content] = propre.last_utm_content; pf[P.last_utm_term] = propre.last_utm_term; pf[P.last_landing_page] = propre.last_landing_page;
    // Horodatages : seulement si presents (vide -> on n'ecrit pas le champ dateTime).
    if (propre.first_touch_at) pf[P.first_touch_at] = propre.first_touch_at;
    if (propre.last_touch_at)  pf[P.last_touch_at]  = propre.last_touch_at;
    const rp = await fetch(`${API}/${PROJECTS}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: pf, typecast: true }) });
    if (!rp.ok) { console.error('[soumettre-survey direct] create projet:', (await rp.text()).slice(0, 300)); return { ok: false, error: 'projet' }; }
    projet = await rp.json();
    if (lyr) await creerGeneration(headers, projet.id, 1, 'lyrics', lyr);
    // FIRST-touch : lie le Projet a la Pub du 1er creatif (ad_name = utm_content first-touch).
    // Best-effort : si la Pub n'existe pas encore (Insights pas passe), pub-join-cron rattrapera.
    try { await lierPub(API, headers, projet.id, propre.utm_content, P.Pub); } catch (_) {}
  } else if (lyr) {
    const maxNo = await dernierNo(headers, projet.fields.project);
    await creerGeneration(headers, projet.id, maxNo + 1, 'lyrics_regeneration', lyr);
  }
  return { ok: true };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Méthode non permise' }) };

  let data;
  try { data = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) }; }

  // Filtre anti-bot : un vrai sondage porte toujours un token UUID v4.
  const token = (data && typeof data.token === 'string') ? data.token.trim() : '';
  if (!UUID_V4.test(token)) return { statusCode: 400, body: JSON.stringify({ error: 'Requête invalide' }) };

  // Nettoyage serveur de toutes les valeurs texte (anti « Bad control character » côté Make A).
  const propre = {};
  for (const k of Object.keys(data)) propre[k] = nettoyer(data[k]);
  propre.token = token;

  // MODE DIRECT (remplace MAKE A) si activé. Sinon -> transfert historique vers Make A.
  if (process.env.SURVEY_DIRECT === '1') {
    try {
      const res = await traiterDirect(propre, { Authorization: `Bearer ${AT_TOKEN}` });
      // Lead CAPI serveur (ex-MAKE A) : MAKE A est éteint en mode DIRECT, donc on déclenche nous-mêmes
      // l'event Lead côté serveur (dédup avec le pixel navigateur via event_id = token.lead). IP/UA du
      // vrai client (il appelle ce endpoint directement) -> meilleure qualité de matching Meta. Best-effort.
      if (res && res.ok) {
        try {
          const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || '').split(',')[0].trim();
          const ua = event.headers['user-agent'] || '';
          await fetch(`${SITE}/api/suivi-funnel`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: token, event: 'lead', client_ip_address: ip, client_user_agent: ua })
          });
        } catch (_) {}
      }
      return { statusCode: res.ok ? 200 : 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(res) };
    } catch (err) {
      console.error('[soumettre-survey direct]', err && err.message);
      return { statusCode: 502, body: JSON.stringify({ error: 'Traitement échoué' }) };
    }
  }

  try {
    const r = await fetch(MAKE_A_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(propre)
    });
    if (!r.ok) {
      console.error('[soumettre-survey] Make A a refusé:', r.status);
      return { statusCode: 502, body: JSON.stringify({ error: 'Soumission échouée' }) };
    }
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('[soumettre-survey]', err && err.message);
    return { statusCode: 502, body: JSON.stringify({ error: 'Soumission échouée' }) };
  }
};

// Toute exception non geree -> Sentry, puis relancee (comportement inchange).
exports.handler = withSentry(exports.handler);
