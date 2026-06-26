// netlify/functions/_lib/pied-courriel.js
//
// Pied de courriel client Chanson Memoire : salutation selon l'heure du Quebec + signature Nathalie / L'equipe.
// Partage par les BROUILLONS (brouillon-cron, decortique-background) ET l'ENVOI (repondre-courriel) -> une seule
// source pour la signature. Le brouillon affiche deja le pied (Maxime relit le courriel complet) ; a l'envoi,
// repondre-courriel ne le re-ajoute pas si le texte contient deja la signature (garde anti-double).

// Salutation selon l'heure locale du Quebec (America/Toronto) : « Bonne journee » le jour, « Bonne soiree » le soir.
function salutationHeure() {
  let h = 12;
  try { h = parseInt(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: 'numeric', hour12: false }).format(new Date()), 10); } catch (_) {}
  if (!Number.isInteger(h)) h = 12;
  return (h % 24) >= 18 ? 'Bonne soirée' : 'Bonne journée';
}

// Pied : salutation du moment + signature Nathalie / L'equipe Chanson Memoire.
function piedAuto() { return `${salutationHeure()},\nNathalie\nL'équipe Chanson Mémoire`; }

module.exports = { salutationHeure, piedAuto };
