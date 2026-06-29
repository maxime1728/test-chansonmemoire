// tests/lyrics.test.js — verrouille stripSectionTags (les balises [Verse]/[Chorus] ne doivent JAMAIS
// s'afficher au client) et accentFor (accent Suno selon la langue).

const { test } = require('node:test');
const assert = require('node:assert');
const { stripSectionTags, accentFor } = require('../netlify/functions/_lib/lyrics');

test('stripSectionTags : retire les lignes-balises, garde les paroles', () => {
  const r = stripSectionTags('[Intro]\nUne ligne\n[Chorus]\nUne autre');
  assert.ok(!r.includes('['), 'aucune balise ne doit rester');
  assert.ok(r.includes('Une ligne') && r.includes('Une autre'));
});

test('stripSectionTags : ne retire PAS une balise au milieu d une ligne de paroles', () => {
  // Securite : une vraie ligne de texte avec un crochet inline n'est pas une ligne-balise seule.
  const r = stripSectionTags('Je pense [a toi] toujours');
  assert.strictEqual(r, 'Je pense [a toi] toujours');
});

test('stripSectionTags : reduit 3+ sauts de ligne a 2 et trim', () => {
  const r = stripSectionTags('\n\n[Verse]\n\n\nMot\n\n');
  assert.strictEqual(r, 'Mot');
});

test('stripSectionTags : entrees vides -> chaine vide', () => {
  assert.strictEqual(stripSectionTags(''), '');
  assert.strictEqual(stripSectionTags(null), '');
  assert.strictEqual(stripSectionTags(undefined), '');
});

test('accentFor : codes connus', () => {
  assert.ok(accentFor('fr-CA').includes('Quebec'));
  assert.strictEqual(accentFor('es'), 'Spanish');
  assert.strictEqual(accentFor('en'), 'English');
});

test('accentFor : code inconnu / vide -> defaut fr-CA', () => {
  assert.ok(accentFor('xx').includes('Quebec'));
  assert.ok(accentFor(undefined).includes('Quebec'));
});
