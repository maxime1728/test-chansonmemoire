// netlify/functions/_lib/sequences.js
//
// REGISTRE des séquences de courriels (moteur multi-séquences -> table Inscriptions, via sequences-cron).
// Ajouter une séquence = ajouter une entrée ici (id = un choix du champ Inscriptions.sequence) + un
// choix correspondant dans Airtable. Voix de marque (CLAUDE.md §1) : solution-first, digne, québécois,
// vouvoiement, AUCUN tiret cadratim. LCAP : pied avec désabonnement + adresse postale.
//
// Chaque séquence : { id, label, enrollFormula, exit(projectFields)->bool, emails:[{gapBeforeH, subject, html(ctx)}] }
//   - enrollFormula : formule Airtable pour TROUVER les Projets éligibles (l'unicité est gérée par le moteur).
//   - exit          : true => on arrête l'inscription (ex. remboursé). (La désinscription est globale.)
//   - emails        : gapBeforeH = délai avant CET envoi (depuis l'inscription pour le 1er, depuis l'envoi
//                     précédent ensuite). ctx = { prenom, lien, unsub, postal }.

const SITE = 'https://chansonmemoire.ca';

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

function btn(href, label) {
  return `<p style="margin:22px 0;"><a href="${href}" style="background:#5C2D4A;color:#F5F0EA;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block;">${label}</a></p>`;
}

// Enveloppe de marque + pied LCAP (désabonnement + adresse postale).
function shell(inner, ctx) {
  return `<div style="font-family:Georgia,'Times New Roman',serif;color:#2E1A28;line-height:1.7;font-size:16px;max-width:560px;">`
    + inner
    + `<p style="color:#7A6070;margin-top:22px;">L'équipe Chanson Mémoire</p>`
    + `<hr style="border:none;border-top:1px solid #E5DAE0;margin:22px 0 10px;">`
    + `<div style="color:#9A8A96;font-size:12px;line-height:1.5;">`
    + (ctx.postal ? esc(ctx.postal) + '<br>' : '')
    + `Vous recevez ce courriel parce que vous avez créé une chanson avec nous. `
    + `<a href="${ctx.unsub}" style="color:#9A8A96;">Se désabonner</a>.`
    + `</div></div>`;
}

// ───────────────────── Séquence 1 : BIENVENUE / post-achat (fidélisation + 1er partage) ─────────────────────
const POST_ACHAT = {
  id: 'post_achat',
  label: 'Bienvenue (post-achat)',
  // Acheteurs récents, non désinscrits. Fenêtre 21 j sur created_date = n'enrôle pas tout l'historique au déploiement.
  enrollFormula: `AND({commercial_status}='purchased', {nurture_status}!='unsubscribed', IS_AFTER({created_date}, DATEADD(NOW(),-504,'hours')))`,
  exit: (f) => (f.commercial_status || '') === 'refunded',
  emails: [
    {
      gapBeforeH: 24,
      subject: 'Un conseil pour garder votre chanson',
      html: (c) => shell(
        `<p>Bonjour,</p>`
        + `<p>Votre chanson vous appartient. Pour l'avoir toujours avec vous, même sans Internet, téléchargez le fichier sur votre appareil depuis votre page.</p>`
        + btn(c.lien, 'Ouvrir ma page')
        + `<p>Gardez-la précieusement, et réécoutez-la quand le cœur vous en dit.</p>`, c)
    },
    {
      gapBeforeH: 48,
      subject: 'Les paroles de votre chanson, en format souvenir',
      html: (c) => shell(
        `<p>Bonjour,</p>`
        + `<p>En plus de votre chanson, vous avez une belle version des paroles à imprimer, en format souvenir.</p>`
        + btn(c.lien, 'Voir mes paroles')
        + `<p>Glissées dans un cadre ou dans un livre, elles prolongent joliment le moment.</p>`, c)
    },
    {
      gapBeforeH: 72,
      subject: 'Et si vous la faisiez entendre à vos proches ?',
      html: (c) => shell(
        `<p>Bonjour,</p>`
        + `<p>Une chanson comme la vôtre prend tout son sens quand on la partage. Vous pouvez envoyer le lien à votre famille et à vos proches : ils pourront l'écouter eux aussi.</p>`
        + btn(c.lien, 'Partager ma chanson')
        + `<p>Merci de faire vivre ces moments avec nous.</p>`, c)
    }
  ]
};

// ───────────────────── Séquence 2 : PARRAINAGE / partage (AUCUN rabais, clics tracés) ─────────────────────
// Pas d'incitatif : on invite simplement à faire découvrir CM. Le bouton passe par /api/clic (redirection
// tracée -> table Clics) pour mesurer l'engagement. Le client partage lui-même (jamais de courriel à un tiers).
const PARRAINAGE = {
  id: 'parrainage',
  label: 'Parrainage / partage',
  enrollFormula: `AND({commercial_status}='purchased', {nurture_status}!='unsubscribed', IS_AFTER({created_date}, DATEADD(NOW(),-504,'hours')))`,
  exit: (f) => (f.commercial_status || '') === 'refunded',
  emails: [
    {
      gapBeforeH: 288,   // ~J+12 après l'achat (valeur ressentie)
      subject: 'Connaissez-vous quelqu\'un que ça toucherait ?',
      html: (c) => shell(
        `<p>Bonjour,</p>`
        + `<p>Si votre chanson vous a touché, elle parlera peut-être aussi à quelqu'un de votre entourage. Faites découvrir Chanson Mémoire à un proche qui aimerait garder une voix, un souvenir, bien vivant.</p>`
        + btn(`${SITE}/api/clic?c=parrainage&t=${encodeURIComponent(c.token)}&u=${encodeURIComponent(SITE)}`, 'Faire découvrir Chanson Mémoire')
        + `<p>Merci de faire connaître ces moments autour de vous.</p>`, c)
    }
  ]
};

// ───────────────────── Séquence 3 : CROSS-SELL (pont hommage <-> cadeau) ─────────────────────
// J+30. S'adapte au type acheté : acheteur HOMMAGE -> on suggère une chanson CADEAU (vivant, occasion) ;
// acheteur CADEAU -> on rouvre la porte (autre occasion / hommage). CTA tracé (campagne cross_sell) vers
// le formulaire. Le saisonnier (fêtes) = mécanisme séparé (envoi daté à un segment), à venir.
const CROSS_SELL = {
  id: 'cross_sell',
  label: 'Cross-sell (hommage <-> cadeau)',
  enrollFormula: `AND({commercial_status}='purchased', {nurture_status}!='unsubscribed', IS_AFTER({created_date}, DATEADD(NOW(),-504,'hours')))`,
  exit: (f) => (f.commercial_status || '') === 'refunded',
  emails: [
    {
      gapBeforeH: 720,   // ~J+30 après l'achat (cross-sell seulement après que la valeur est ressentie)
      subject: 'Une chanson, pour une autre personne qui compte ?',
      html: (c) => {
        const corps = (c.song_type === 'cadeau')
          ? `<p>Vous avez offert une chanson à quelqu'un que vous aimez. Pour une autre occasion, ou pour garder vivante la voix d'une personne qui vous manque, on peut en créer une nouvelle quand vous voulez.</p>`
          : `<p>Une chanson, c'est aussi un beau cadeau pour les vivants. Pour un anniversaire, une fête, ou simplement pour dire à quelqu'un qu'il compte, vous pouvez lui offrir sa propre chanson.</p>`;
        return shell(
          `<p>Bonjour,</p>` + corps
          + btn(`${SITE}/api/clic?c=cross_sell&t=${encodeURIComponent(c.token)}&u=${encodeURIComponent(SITE + '/souvenirs')}`, 'Créer une nouvelle chanson')
          + `<p>On est là quand le moment sera bon.</p>`, c);
      }
    }
  ]
};

// ───────────────────── Saisonnier : NOËL / temps des fêtes (campagne datée, segment large) ─────────────────────
// Mécanisme saisonnier sur le MÊME moteur : la fenêtre de dates est DANS l'enrollFormula -> personne ne
// s'enrôle hors campagne ; pendant la fenêtre, chaque contact du segment reçoit 1 courriel (l'inscription
// empêche le renvoi). L'an prochain : dupliquer avec un nouvel id (noel_2027) + nouvelles dates.
// Segment : non désinscrits ET (acheteurs OU leads de moins d'un an). Envoi début décembre (délai avant Noël).
const NOEL_2026 = {
  id: 'noel_2026',
  label: 'Temps des fêtes 2026',
  enrollFormula: `AND({nurture_status}!='unsubscribed', OR({commercial_status}='purchased', IS_AFTER({created_date}, DATEADD(NOW(),-365,'days'))), IS_AFTER(NOW(), DATETIME_PARSE('2026-12-01','YYYY-MM-DD')), IS_BEFORE(NOW(), DATETIME_PARSE('2026-12-12','YYYY-MM-DD')))`,
  exit: () => false,   // campagne ponctuelle, pas de condition de sortie
  emails: [
    {
      gapBeforeH: 0,   // envoi immédiat dès l'inscription (pendant la fenêtre)
      subject: 'Un cadeau de Noël qui reste, longtemps après les fêtes',
      html: (c) => shell(
        `<p>Bonjour,</p>`
        + `<p>Le temps des fêtes approche. Cette année, offrez quelque chose qui dure : une chanson personnalisée, pour honorer une personne qui vous manque, ou pour faire plaisir à quelqu'un que vous aimez.</p>`
        + `<p>Pensez à la créer tôt, pour l'avoir bien à temps sous le sapin.</p>`
        + btn(`${SITE}/api/clic?c=noel_2026&t=${encodeURIComponent(c.token)}&u=${encodeURIComponent(SITE + '/souvenirs')}`, 'Créer une chanson pour les fêtes')
        + `<p>Joyeuses fêtes,</p>`, c)
    }
  ]
};

const SEQUENCES = [POST_ACHAT, PARRAINAGE, CROSS_SELL, NOEL_2026];

module.exports = { SEQUENCES };
