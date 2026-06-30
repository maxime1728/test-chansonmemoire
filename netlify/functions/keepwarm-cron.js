// netlify/functions/keepwarm-cron.js
//
// KEEP-WARM (anti cold-start) : garde au chaud les fonctions appelees au CHARGEMENT des pages client,
// pour qu'un lien (courriel, redirection) tombe sur un conteneur deja demarre (~0,3 s) plutot que sur
// un demarrage a froid (plusieurs secondes apres une periode sans trafic).
//
// Comment : un simple GET sur chaque cible -> la fonction repond 405 IMMEDIATEMENT (garde httpMethod),
// AVANT toute validation/Airtable. Ca charge le module (= le vrai cout du cold start) sans aucun effet
// de bord (zero ecriture, zero lecture Airtable, zero credit). Best-effort : un echec ne casse rien.
//
// Limite assumee : ca garde UN conteneur chaud par fonction (un 2e visiteur simultane peut quand meme
// demarrer a froid) ; un nouveau deploy repart a froid. Cout fixe, independant du trafic -> a retirer
// quand le vrai trafic suffira a garder les fonctions chaudes. Cf. lazy-Sentry (_lib/sentry.js) qui,
// lui, raccourcit le cold start quand il arrive malgre tout.
//
// Planifie dans netlify.toml (toutes les 5 min). Les conteneurs Lambda restent chauds ~5-15 min.

// Fonctions vues par le client au chargement d'une page (page-chanson / page-memoire / attente / exemple).
const CIBLES = ['lire-projet', 'lire-versions'];

exports.handler = async () => {
  // URL du deploiement courant (prod en prod, branch deploy en preview) -> on ping le bon environnement.
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://chansonmemoire.ca';

  const resultats = await Promise.allSettled(
    CIBLES.map((fn) =>
      // GET volontaire -> 405 immediat (les handlers n'acceptent que POST). Charge le conteneur, rien d'autre.
      fetch(`${base}/api/${fn}`, { method: 'GET', headers: { 'x-cm-keepwarm': '1' } })
    )
  );

  const ok = resultats.filter((r) => r.status === 'fulfilled').length;
  return { statusCode: 200, body: JSON.stringify({ ok: true, pinged: CIBLES.length, reached: ok }) };
};
