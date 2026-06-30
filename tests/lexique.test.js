// tests/lexique.test.js — verrouille le moteur du dictionnaire phonétique (_lib/lexique.js).
// Pur, zéro dépendance (node:test), tourné en CI. Voir cm-lexique-phonetique-plan.

const { test } = require('node:test');
const assert = require('node:assert');
const { appliquerLexique, dictionnaireEffectif, cleMot, majEntree } = require('../netlify/functions/_lib/lexique');

test('applique une réécriture (limites de mot, insensible casse)', () => {
  const out = appliquerLexique('Roxanne dort, ROXANNE rêve, proxanne reste', [{ mot: 'Roxanne', phonetique: 'Roksane' }]);
  assert.strictEqual(out, 'Roksane dort, Roksane rêve, proxanne reste');   // "proxanne" (mot partiel) PAS touché
});

test('plusieurs mots + accents', () => {
  const out = appliquerLexique('Ghislaine et Roxanne', [
    { mot: 'Ghislaine', phonetique: 'Jislaine' },
    { mot: 'Roxanne', phonetique: 'Roksane' }
  ]);
  assert.strictEqual(out, 'Jislaine et Roksane');
});

test('accepte une Map et ignore réécriture vide ou identique', () => {
  const m = new Map([['juin', 'ju-un'], ['mai', 'mai'], ['mars', '']]);
  assert.strictEqual(appliquerLexique('En juin, mai et mars', m), 'En ju-un, mai et mars');
});

test('cleMot : insensible casse + trim, garde les accents', () => {
  assert.strictEqual(cleMot('  Ghislaine '), 'ghislaine');
  assert.strictEqual(cleMot('JUIN'), 'juin');
});

test('dictionnaireEffectif : global + override projet (override gagne)', () => {
  const globales = [{ mot: 'Roxanne', phonetique: 'Roksane' }, { mot: 'Juin', phonetique: 'ju-un' }];
  const overrides = [{ mot: 'roxanne', phonetique: 'Rocksanne' }];   // ce projet veut une autre graphie
  const map = dictionnaireEffectif(globales, overrides);
  assert.strictEqual(map.get('roxanne'), 'Rocksanne');   // override
  assert.strictEqual(map.get('juin'), 'ju-un');          // global conservé
});

test('dictionnaireEffectif : un override desactive retire le mot pour le projet', () => {
  const globales = [{ mot: 'Roxanne', phonetique: 'Roksane' }];
  const overrides = [{ mot: 'Roxanne', desactive: true }];
  const map = dictionnaireEffectif(globales, overrides);
  assert.strictEqual(map.has('roxanne'), false);
});

test('dictionnaireEffectif : ignore les entrées globales désactivées ou vides', () => {
  const map = dictionnaireEffectif([{ mot: 'X', phonetique: 'Y', desactive: true }, { mot: 'A', phonetique: '' }], []);
  assert.strictEqual(map.size, 0);
});

test('majEntree : nouveau mot = 1re tentative, pas d\'historique', () => {
  assert.deepStrictEqual(majEntree(null, 'Roksane'), { phonetique: 'Roksane', attempts: 1, historique: '' });
});

test('majEntree : nouvelle graphie -> ancienne va dans l\'historique + compte les essais', () => {
  const r = majEntree({ phonetique: 'Roksane', attempts: 1, historique: '' }, 'Rocksanne');
  assert.strictEqual(r.phonetique, 'Rocksanne');
  assert.strictEqual(r.attempts, 2);
  assert.strictEqual(r.historique, 'Roksane');
});

test('majEntree : 3e essai cumule l\'historique, sans doublon', () => {
  const r = majEntree({ phonetique: 'Rocksanne', attempts: 2, historique: 'Roksane' }, 'Roxsann');
  assert.strictEqual(r.historique, 'Roksane\nRocksanne');
  assert.strictEqual(r.attempts, 3);
});

test('majEntree : réécriture inchangée ou vide -> null (rien à écrire)', () => {
  assert.strictEqual(majEntree({ phonetique: 'Roksane', attempts: 1 }, 'Roksane'), null);
  assert.strictEqual(majEntree(null, '   '), null);
});
