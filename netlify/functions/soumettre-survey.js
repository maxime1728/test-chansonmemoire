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
const MAKE_A_URL = process.env.MAKE_A_WEBHOOK_URL || 'https://hook.us1.make.com/1dyhk11x8yf1biy8mawnepdt3k1rcqvq';

function nettoyer(v) {
  if (typeof v !== 'string') return v;
  return v.replace(CTRL, ' ').replace(/[\\"]/g, "'").trim();
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
