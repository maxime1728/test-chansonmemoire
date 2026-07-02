// Non-régression du PORTAGE des prompts : _lib/prompts/paroles.ts doit être
// IDENTIQUE AU CARACTÈRE PRÈS aux prompts du legacy generate-lyrics.js (l'outil
// quotidien prouvé en usage réel). Tant que les deux coexistent, toute dérive
// casse la CI. Idem pour le parseur tolérant (_lib/anthropic.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  LANGS,
  langOf,
  systemCreate,
  systemCreateGift,
  systemRegenerate,
  userPromptCreation,
} from '../netlify/functions/_lib/prompts/paroles';
import { parseModel, normSuggestions } from '../netlify/functions/_lib/anthropic';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const legacy = require('../netlify/functions/generate-lyrics.js');

const CODES = ['fr-CA', 'fr-FR', 'en', 'es', 'xx-inconnu'];

test('systemCreate : identique au legacy pour chaque langue', () => {
  for (const code of CODES) {
    assert.equal(systemCreate(langOf(code)), legacy.systemCreate(legacy.langOf(code)), `langue ${code}`);
  }
});

test('systemCreateGift : identique au legacy pour chaque langue', () => {
  for (const code of CODES) {
    assert.equal(systemCreateGift(langOf(code)), legacy.systemCreateGift(legacy.langOf(code)), `langue ${code}`);
  }
});

test('systemRegenerate : identique au legacy (hommage ET cadeau)', () => {
  for (const code of CODES) {
    for (const isGift of [false, true]) {
      assert.equal(
        systemRegenerate(langOf(code), isGift),
        legacy.systemRegenerate(legacy.langOf(code), isGift),
        `langue ${code}, cadeau=${isGift}`,
      );
    }
  }
});

test('langOf : mêmes langues supportées, même repli fr-CA', () => {
  assert.deepEqual(Object.keys(LANGS), ['fr-CA', 'fr-FR', 'en', 'es']);
  assert.deepEqual(langOf(undefined), LANGS['fr-CA']);
  assert.deepEqual(langOf('inconnue'), LANGS['fr-CA']);
});

test('userPromptCreation : même gabarit que le legacy (champs vides -> mêmes replis)', () => {
  // Construit par concaténation : les champs vides laissent un espace final réel
  // (« - Mood: ␣ ») que le gabarit legacy produit aussi.
  const attendu = [
    'Provided information:',
    '- In memory of: Jean Tremblay',
    '- Relationship to the person ordering: son fils',
    '- Musical style: country',
    '- Mood: ',
    '- What made them unique: sa générosité',
    '- Shared memories: ',
    '- What we want to keep and pass on: ',
  ].join('\n');
  assert.equal(
    userPromptCreation({ deceased_name: 'Jean Tremblay', relationship: 'son fils', music_style: 'country', what_made_unique: 'sa générosité' }),
    attendu,
  );
  assert.ok(userPromptCreation({}).includes('In memory of: cette personne'), 'repli deceased_name');
});

/* ── parseModel : mêmes verdicts que le legacy sur les cas réels difficiles ── */
function reponse(text: string) {
  return { content: [{ type: 'text', text }] };
}

const CAS = [
  reponse('{"title":"Ton café","lyrics":"[Verse]\\nLigne un\\nLigne deux","suggestions":["Un","Deux"]}'),
  reponse('```json\n{"title":"T","lyrics":"L1\\nL2","suggestions":[]}\n```'),
  // Le piège n°1 : sauts de ligne BRUTS dans la valeur JSON (JSON invalide).
  reponse('{"title":"Ton café","lyrics":"[Verse]\nPremière ligne\nDeuxième ligne","suggestions":["Parlez de son chalet"]}'),
  reponse('{"error":"invalid_input"}'),
  reponse('désolé, je ne peux pas'),
  { content: [] },
];

test('parseModel TS : mêmes résultats que le legacy sur les cas difficiles', () => {
  for (const [i, cas] of CAS.entries()) {
    assert.deepEqual(parseModel(cas), legacy.parseModel(cas), `cas #${i}`);
  }
});

test('normSuggestions : filtre et plafonne comme le legacy', () => {
  const brut = ['ok', '', '  ', 42, 'deux', 'trois', 'quatre'];
  assert.deepEqual(normSuggestions(brut), legacy.normSuggestions(brut));
  assert.deepEqual(normSuggestions('pas un tableau'), []);
});
