// Tests unitaires de la vérification de signature Stripe (portage exact du legacy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { signatureValide } from '../netlify/functions/_lib/stripe';

function signer(raw: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${raw}`, 'utf8').digest('hex');
  return `t=${t},v1=${v1}`;
}

test('signature valide acceptée ; corps altéré ou secret différent refusés', () => {
  const raw = '{"id":"evt_1","type":"checkout.session.completed"}';
  const sig = signer(raw, 'whsec_test');
  assert.equal(signatureValide(raw, sig, 'whsec_test'), true);
  assert.equal(signatureValide(raw + ' ', sig, 'whsec_test'), false, 'corps altéré');
  assert.equal(signatureValide(raw, sig, 'whsec_autre'), false, 'mauvais secret');
  assert.equal(signatureValide(raw, undefined, 'whsec_test'), false, 'en-tête absent');
});

test('fenêtre anti-rejeu : signature de plus de 5 minutes refusée', () => {
  const raw = '{}';
  const vieux = Math.floor(Date.now() / 1000) - 600;
  assert.equal(signatureValide(raw, signer(raw, 'whsec_test', vieux), 'whsec_test'), false);
});
