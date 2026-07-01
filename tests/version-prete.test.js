// tests/version-prete.test.js — verrouille l'email « nouvelle version prête » (#19, helper pur partagé
// par livrerCover et le watchdog). Pure, zero dependance (node:test), tournee en CI.

const { test } = require('node:test');
const assert = require('node:assert');
const { htmlNouvelleVersion } = require('../netlify/functions/_lib/cover');

test('htmlNouvelleVersion : utilise page_url quand fournie + zero tiret cadratin', () => {
  const html = htmlNouvelleVersion({ token: 'abc', page_url: 'https://chansonmemoire.ca/espace-client?id=abc' }, 'https://site');
  assert.ok(html.includes('https://chansonmemoire.ca/espace-client?id=abc'));
  assert.ok(!html.includes('—'));   // jamais d'em-dash dans le copy (regle de marque)
  assert.ok(html.includes('Votre nouvelle version est prête'));
});

test('htmlNouvelleVersion : retombe sur site + token quand pas de page_url', () => {
  const html = htmlNouvelleVersion({ token: 'xyz' }, 'https://site');
  assert.ok(html.includes('https://site/espace-client?id=xyz'));
});
