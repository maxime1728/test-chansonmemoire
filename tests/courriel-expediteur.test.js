// tests/courriel-expediteur.test.js — verrouille le ROUTAGE From / sous-domaine d'envoi par TYPE.
// SPLIT d'expéditeur (Maxime 2026-06-30) : 'support' (ton humain, souvent rédigé par l'IA) = nathalie@ ;
// TOUT le reste (reçu, « version prête », cadeau, recovery, nurture, séquences) = notifications@ (machine).
// On envoie TOUJOURS via un sous-domaine (jamais la racine) pour protéger le domaine ; seul le From AFFICHÉ
// change. Pur, node:test, tourné en CI sur chaque PR.

const { test } = require('node:test');
const assert = require('node:assert');
const { expediteurParType } = require('../netlify/functions/_lib/courriel');

// Efface les surcharges MAILGUN_* pour tester les DÉFAUTS de façon déterministe, puis restaure.
const KEYS = ['MAILGUN_FROM', 'MAILGUN_FROM_NOTIF', 'MAILGUN_FROM_ACHAT', 'MAILGUN_FROM_MARKETING', 'MAILGUN_FROM_SUPPORT',
              'MAILGUN_DOMAIN_ACHAT', 'MAILGUN_DOMAIN_MARKETING', 'MAILGUN_DOMAIN_SUPPORT', 'MAILGUN_DOMAIN'];
function sansEnv(fn) {
  const sauve = {};
  for (const k of KEYS) { sauve[k] = process.env[k]; delete process.env[k]; }
  try { fn(); } finally { for (const k of KEYS) { if (sauve[k] === undefined) delete process.env[k]; else process.env[k] = sauve[k]; } }
}

test('machine (achat/cadeau/cover) -> From notifications@ affiché', () => {
  sansEnv(() => {
    for (const t of ['achat', 'cadeau', 'cover']) {
      assert.match(expediteurParType(t).from, /<notifications@chansonmemoire\.ca>/, `${t} doit afficher notifications@`);
    }
  });
});

test('support -> From nathalie@ (humain) + envoi via le sous-domaine support', () => {
  sansEnv(() => {
    const e = expediteurParType('support');
    assert.match(e.from, /<nathalie@chansonmemoire\.ca>/);
    assert.strictEqual(e.domain, 'support.chansonmemoire.ca');
  });
});

test('marketing (nurture/sequence/recovery) -> From notifications@ (envoi via sous-domaine info.)', () => {
  sansEnv(() => {
    for (const t of ['nurture', 'sequence', 'recovery']) {
      assert.match(expediteurParType(t).from, /<notifications@chansonmemoire\.ca>/, `${t} affiche notifications@`);
    }
  });
});

test('type inconnu -> traité comme machine (From notifications@, jamais échec silencieux)', () => {
  sansEnv(() => {
    assert.match(expediteurParType('autre').from, /<notifications@chansonmemoire\.ca>/);
  });
});

test('MAILGUN_FROM_NOTIF surcharge le From des flux machine', () => {
  const sauve = process.env.MAILGUN_FROM_NOTIF;
  process.env.MAILGUN_FROM_NOTIF = 'Test <robot@exemple.ca>';
  try {
    assert.strictEqual(expediteurParType('achat').from, 'Test <robot@exemple.ca>');
    assert.strictEqual(expediteurParType('nurture').from, 'Test <robot@exemple.ca>');
  } finally { if (sauve === undefined) delete process.env.MAILGUN_FROM_NOTIF; else process.env.MAILGUN_FROM_NOTIF = sauve; }
});

test('MAILGUN_FROM surcharge le From du support (humain), sans toucher aux flux machine', () => {
  const sauveF = process.env.MAILGUN_FROM, sauveN = process.env.MAILGUN_FROM_NOTIF;
  process.env.MAILGUN_FROM = 'Support <nath@exemple.ca>';
  delete process.env.MAILGUN_FROM_NOTIF;
  try {
    assert.strictEqual(expediteurParType('support').from, 'Support <nath@exemple.ca>');
    assert.match(expediteurParType('achat').from, /<notifications@chansonmemoire\.ca>/);   // machine non affecté
  } finally {
    if (sauveF === undefined) delete process.env.MAILGUN_FROM; else process.env.MAILGUN_FROM = sauveF;
    if (sauveN === undefined) delete process.env.MAILGUN_FROM_NOTIF; else process.env.MAILGUN_FROM_NOTIF = sauveN;
  }
});

test('le domaine d ENVOI marketing vient de l env (MAILGUN_DOMAIN_MARKETING)', () => {
  const sauve = process.env.MAILGUN_DOMAIN_MARKETING;
  process.env.MAILGUN_DOMAIN_MARKETING = 'info.chansonmemoire.ca';
  try { assert.strictEqual(expediteurParType('nurture').domain, 'info.chansonmemoire.ca'); }
  finally { if (sauve === undefined) delete process.env.MAILGUN_DOMAIN_MARKETING; else process.env.MAILGUN_DOMAIN_MARKETING = sauve; }
});
