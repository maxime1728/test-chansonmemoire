// tests/observabilite.test.js — verrouille le comportement des wrappers withSentry / withCron :
// ils doivent etre TRANSPARENTS pour l'appelant (memes retours, erreurs relancees), inertes sans env.

const { test } = require('node:test');
const assert = require('node:assert');
const { withSentry } = require('../netlify/functions/_lib/sentry');
const { withCron } = require('../netlify/functions/_lib/cron');

test('withSentry : retourne le resultat du handler (succes)', async () => {
  const h = withSentry(async () => ({ statusCode: 200, body: 'ok' }));
  assert.deepStrictEqual(await h({}, {}), { statusCode: 200, body: 'ok' });
});

test('withSentry : relance l erreur (comportement inchange pour l appelant)', async () => {
  const h = withSentry(async () => { throw new Error('boom'); });
  await assert.rejects(() => h({}, {}), /boom/);
});

test('withCron : retourne le resultat (succes)', async () => {
  const h = withCron('test-cron', async () => ({ statusCode: 200 }));
  assert.deepStrictEqual(await h({}, {}), { statusCode: 200 });
});

test('withCron : relance l erreur', async () => {
  const h = withCron('test-cron', async () => { throw new Error('cron-boom'); });
  await assert.rejects(() => h({}, {}), /cron-boom/);
});
