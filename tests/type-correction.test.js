// tests/type-correction.test.js — verrouille le LIBELLE « type de correction » du cockpit (#18).
// Derive du mode + des categories de l'analyse partagee (Conversations.type_correction).
// Pure, zero dependance (node:test), tournee en CI sur chaque PR.

const { test } = require('node:test');
const assert = require('node:assert');
const { typeCorrection } = require('../netlify/functions/_lib/analyse-modif');

test('regeneration -> nouvelle chanson (rege)', () => {
  assert.strictEqual(typeCorrection({ mode: 'regeneration', categories: 'style_ambiance' }), 'nouvelle chanson (régé)');
});

test('cover + style/ambiance touche -> cover (melodie gardee)', () => {
  assert.strictEqual(typeCorrection({ mode: 'cover', categories: 'paroles, style_ambiance' }), 'cover (mélodie gardée)');
});

test('cover + paroles seulement -> paroles seules', () => {
  assert.strictEqual(typeCorrection({ mode: 'cover', categories: 'paroles' }), 'paroles seules');
});

test('defaut / entree vide -> paroles seules', () => {
  assert.strictEqual(typeCorrection({}), 'paroles seules');
});
