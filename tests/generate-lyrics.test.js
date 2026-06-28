// tests/generate-lyrics.test.js — verrouille le parseModel tolerant (cause n°1 des paroles manquantes :
// le modele met parfois de VRAIS sauts de ligne dans la valeur JSON "lyrics" -> JSON.parse echoue).

const { test } = require('node:test');
const assert = require('node:assert');
const { parseModel } = require('../netlify/functions/generate-lyrics');

const D = txt => ({ content: [{ type: 'text', text: txt }] });

test('JSON valide (\\n echappes) : parse normal', () => {
  const r = parseModel(D('{"title":"Pour Ghislaine","lyrics":"[Verse]\\nDans le jardin\\n[Chorus]\\nSon rire","suggestions":["A","B"]}'));
  assert.ok(r);
  assert.strictEqual(r.title, 'Pour Ghislaine');
  assert.ok(r.lyrics.includes('[Verse]') && r.lyrics.includes('[Chorus]'));
  assert.strictEqual(r.suggestions.length, 2);
});

test('JSON invalide (vrais sauts de ligne dans lyrics) : repli recupere les paroles', () => {
  const r = parseModel(D('{"title":"Pour Ghislaine","lyrics":"[Verse]\nDans le jardin\n[Chorus]\nSon rire","suggestions":["Parlez des tartes"]}'));
  assert.ok(r, 'le repli doit recuperer un objet');
  assert.strictEqual(r.title, 'Pour Ghislaine');
  assert.ok(r.lyrics.includes('[Verse]') && r.lyrics.includes('[Chorus]'));
  assert.strictEqual(r.suggestions.length, 1);
});

test('invalid_input detecte', () => {
  assert.strictEqual(parseModel(D('{"error":"invalid_input"}')).error, 'invalid_input');
});

test('garbage non-JSON -> null', () => {
  assert.strictEqual(parseModel(D('pas du json du tout')), null);
});
