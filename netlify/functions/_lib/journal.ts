// _lib/journal.ts — journal structuré + niveaux de gravité (plan v2 §5).
//
// Trois niveaux, sinon alert fatigue :
//   P1 : alerte immédiate (Sentry -> push mobile + courriel). Paiement raté, livraison
//        ratée, génération perdue, /health rouge.
//   P2 : digest quotidien. Retries qui ont fini par réussir, doublons ignorés, bounces isolés.
//   P3 : log structuré seulement, consultable dans les logs Netlify.
//
// Interdits (imposés par scripts/verifier-wrapper.mjs en CI) : catch vide,
// console.log seul pour une erreur, erreur retournée en 200.

export type Niveau = 'P1' | 'P2' | 'P3';

// Efface token (?id=UUID), UUID bruts et courriels d'une chaîne (logs côté serveur).
// Réimplémente _lib/util.js scrubToken pour le code TS ; le .js legacy part au portage.
export function nettoyer(s: string): string {
  return s
    .replace(/([?&]id=)[^&#]+/gi, '$1REDACTED')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, 'REDACTED')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, 'REDACTED');
}

export interface EntreeJournal {
  niveau: Niveau;
  fonction: string;
  message: string;
  [cle: string]: unknown;
}

// Une seule ligne JSON par événement : filtrable dans les logs Netlify, lisible par une machine.
export function journaliser(entree: EntreeJournal): void {
  const { niveau, fonction, message, ...extra } = entree;
  const ligne = JSON.stringify({
    niveau,
    fonction,
    message: nettoyer(message),
    quand: new Date().toISOString(),
    ...extra,
  });
  if (niveau === 'P1') console.error(ligne);
  else if (niveau === 'P2') console.warn(ligne);
  else console.log(ligne);
}
