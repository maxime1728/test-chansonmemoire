// tests/word-diff.test.js — verrouille le diff au mot du cockpit (actuel vs proposé).
// Pur, zéro dépendance (node:test), tourné en CI sur chaque PR.

const { test } = require('node:test');
const assert = require('node:assert');
const { diffMots, tokenize } = require('../netlify/functions/_lib/word-diff');

// Compacte le diff en chaînes par opération, pour des assertions lisibles.
function parOp(diff, op) {
  return diff.filter((d) => d.op === op).map((d) => d.text).join(' ');
}

test('tokenize : mots + sauts de ligne, espaces implicites', () => {
  assert.deepStrictEqual(tokenize('le chat\nnoir'), ['le', 'chat', '\n', 'noir']);
  assert.deepStrictEqual(tokenize('  a   b  '), ['a', 'b']);   // espaces multiples ignorés
  assert.deepStrictEqual(tokenize(''), []);
  assert.deepStrictEqual(tokenize(null), []);
});

test('insertion d\'un mot au milieu', () => {
  const d = diffMots('le chat', 'le gros chat');
  assert.strictEqual(parOp(d, 'eq'), 'le chat');
  assert.strictEqual(parOp(d, 'ins'), 'gros');
  assert.strictEqual(parOp(d, 'del'), '');
});

test('suppression d\'un mot au milieu', () => {
  const d = diffMots('a b c', 'a c');
  assert.strictEqual(parOp(d, 'eq'), 'a c');
  assert.strictEqual(parOp(d, 'del'), 'b');
  assert.strictEqual(parOp(d, 'ins'), '');
});

test('remplacement d\'un mot = del + ins', () => {
  const d = diffMots('je pense à toi', 'je pense à vous');
  assert.strictEqual(parOp(d, 'del'), 'toi');
  assert.strictEqual(parOp(d, 'ins'), 'vous');
  assert.strictEqual(parOp(d, 'eq'), 'je pense à');
});

test('textes identiques = que des eq', () => {
  const d = diffMots('toujours dans mon cœur', 'toujours dans mon cœur');
  assert.strictEqual(d.every((x) => x.op === 'eq'), true);
  assert.strictEqual(parOp(d, 'del'), '');
  assert.strictEqual(parOp(d, 'ins'), '');
});

test('sauts de ligne préservés comme tokens', () => {
  const d = diffMots('un\ndeux', 'un\ndeux\ntrois');
  // le \n final + "trois" sont insérés
  assert.strictEqual(parOp(d, 'ins').includes('trois'), true);
  assert.strictEqual(d.filter((x) => x.text === '\n' && x.op === 'eq').length, 1);
});

test('depuis vide = tout inséré ; vers vide = tout supprimé', () => {
  assert.strictEqual(parOp(diffMots('', 'bonjour le monde'), 'ins'), 'bonjour le monde');
  assert.strictEqual(parOp(diffMots('bonjour le monde', ''), 'del'), 'bonjour le monde');
});
