// netlify/functions/_lib/word-diff.js
//
// DIFF AU MOT (pur, sans dépendance) — utilisé par le cockpit pour surligner « actuel vs proposé »
// (rouge barré = retiré, vert = ajouté). Granularité MOT (pas caractère) : lisible pour des paroles.
// Plus petite sous-séquence commune (LCS) classique. Découpé en TOKENS = un mot (suite de non-espaces)
// OU un saut de ligne `\n` (gardé pour préserver la structure des couplets). Les espaces simples entre
// mots sont implicites (reconstruits au rendu), donc un reflow d'espaces ne crée pas de faux diff.
//
// diffMots(actuel, propose) -> [ { op:'eq'|'del'|'ins', text } ... ]
//   - 'eq'  = inchangé (rendu des deux côtés)
//   - 'del' = présent dans `actuel`, retiré (rendu barré rouge côté actuel)
//   - 'ins' = ajouté dans `propose` (rendu vert côté proposé)
// Le RENDU (espacement, <br>, échappement HTML) est laissé à l'appelant ; ce module reste pur et testable.

function tokenize(s) {
  return String(s == null ? '' : s).replace(/\r\n/g, '\n').match(/\n|[^\s]+/g) || [];
}

// LCS par programmation dynamique (remplissage arrière) puis remontée gloutonne.
function diffTokens(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: 'eq', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ op: 'del', text: a[i] }); i++; }
    else { out.push({ op: 'ins', text: b[j] }); j++; }
  }
  while (i < n) { out.push({ op: 'del', text: a[i] }); i++; }
  while (j < m) { out.push({ op: 'ins', text: b[j] }); j++; }
  return out;
}

function diffMots(actuel, propose) {
  return diffTokens(tokenize(actuel), tokenize(propose));
}

module.exports = { diffMots, tokenize };
