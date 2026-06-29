// tests/stripe-webhook.test.js — verrouille la VERIFICATION DE SIGNATURE Stripe (sécurité critique :
// empêche un POST forgé de marquer un Projet « purchased »). On pose le secret AVANT le require
// (signatureValide capture STRIPE_WEBHOOK_SECRET au chargement du module).

process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { signatureValide } = require('../netlify/functions/stripe-webhook');

function sign(body, t, secret = 'whsec_test_secret') {
  return crypto.createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex');
}

test('signature valide + fraîche -> acceptée', () => {
  const body = '{"type":"checkout.session.completed"}';
  const t = Math.floor(Date.now() / 1000);
  assert.ok(signatureValide(body, `t=${t},v1=${sign(body, t)}`));
});

test('mauvaise signature -> rejetée', () => {
  const body = '{"type":"x"}';
  const t = Math.floor(Date.now() / 1000);
  assert.ok(!signatureValide(body, `t=${t},v1=deadbeefdeadbeef`));
});

test('corps altéré (même signature) -> rejeté', () => {
  const t = Math.floor(Date.now() / 1000);
  const v1 = sign('{"montant":100}', t);
  assert.ok(!signatureValide('{"montant":99999}', `t=${t},v1=${v1}`));
});

test('timestamp trop vieux -> rejeté (anti-rejeu)', () => {
  const body = '{}';
  const t = Math.floor(Date.now() / 1000) - 1000;   // > 5 min
  assert.ok(!signatureValide(body, `t=${t},v1=${sign(body, t)}`));
});

test('header manquant / malformé -> rejeté', () => {
  assert.ok(!signatureValide('{}', ''));
  assert.ok(!signatureValide('{}', 'n_importe_quoi'));
});
