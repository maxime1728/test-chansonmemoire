// Tests du portage CAPI (_lib/meta-capi.ts) : conventions de dédup et garde-fous.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { construireFbc, envoyerLeadCapi, eventIdLead } from '../netlify/functions/_lib/meta-capi';

test('event_id = sha256(token.lead) — même convention que le pixel navigateur', () => {
  const token = '123e4567-e89b-4d3c-8456-426614174000';
  const attendu = createHash('sha256').update(`${token}.lead`).digest('hex');
  assert.equal(eventIdLead(token), attendu);
});

test('fbc : cookie prioritaire, sinon reconstruit fb.1.<ts>.<fbclid>', () => {
  assert.equal(construireFbc('fb.1.999.abc', 'ignoré'), 'fb.1.999.abc');
  const reconstruit = construireFbc(undefined, 'CLIC123', '2026-07-02T00:00:00.000Z');
  assert.equal(reconstruit, `fb.1.${Date.parse('2026-07-02T00:00:00.000Z')}.CLIC123`);
  assert.equal(construireFbc(undefined, undefined), '', 'ni cookie ni fbclid = vide');
});

test('sans env Meta : no-op explicite, jamais de fetch', async () => {
  delete process.env.META_CAPI_TOKEN;
  delete process.env.META_DATASET_ID;
  const r = await envoyerLeadCapi({ token: '123e4567-e89b-4d3c-8456-426614174000', email: 'x@exemple.ca' });
  assert.equal(r.sent, false);
  assert.match(r.summary, /capi-off/);
});

test('courriel interne : jamais envoyé à Meta (skip-interne)', async () => {
  process.env.META_CAPI_TOKEN = 'tok';
  process.env.META_DATASET_ID = 'ds';
  try {
    const interne = (await import('../netlify/functions/_lib/courriels-internes')).COURRIELS_INTERNES[0];
    if (!interne) return; // liste vide : rien à vérifier
    const r = await envoyerLeadCapi({ token: '123e4567-e89b-4d3c-8456-426614174000', email: interne });
    assert.equal(r.sent, false);
    assert.equal(r.summary, 'skip-interne');
  } finally {
    delete process.env.META_CAPI_TOKEN;
    delete process.env.META_DATASET_ID;
  }
});
