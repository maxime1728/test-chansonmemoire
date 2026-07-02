// Tests des briques aperçu v2 : URL audio signée (port exact de lire-projet.js)
// et prompt d'analyse (égalité au caractère près avec le legacy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { buildAudioUrl, parseCloudinary } from '../netlify/functions/_lib/audio';
import { SYSTEM_ANALYSE } from '../netlify/functions/_lib/prompts/analyse';

const require = createRequire(import.meta.url);
const legacyAnalyse = require('../netlify/functions/_lib/analyse-modif.js');

test('SYSTEM d’analyse : identique au legacy (l’outil quotidien, au caractère près)', () => {
  assert.equal(SYSTEM_ANALYSE, legacyAnalyse.SYSTEM);
});

test('parseCloudinary : upload public, authenticated signé, version ignorée', () => {
  assert.deepEqual(parseCloudinary('https://res.cloudinary.com/demo/video/upload/v123/cm_abc.mp3'), {
    cloud: 'demo',
    type: 'upload',
    publicId: 'cm_abc',
    ext: '.mp3',
  });
  assert.deepEqual(
    parseCloudinary('https://res.cloudinary.com/demo/video/authenticated/s--vieux--/v9/cm_xyz.mp3'),
    { cloud: 'demo', type: 'authenticated', publicId: 'cm_xyz', ext: '.mp3' },
  );
  assert.equal(parseCloudinary('https://exemple.com/pas-cloudinary.mp3'), null);
});

test('buildAudioUrl : du_60 DANS la signature SHA-1 (même algorithme que lire-projet.js)', () => {
  process.env.CLOUDINARY_API_SECRET = 'secret-test';
  const url = buildAudioUrl('https://res.cloudinary.com/demo/video/authenticated/s--old--/cm_t1.mp3', 'du_60');
  const sigAttendue = createHash('sha1')
    .update('du_60/cm_t1.mp3' + 'secret-test')
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
    .slice(0, 8);
  assert.equal(url, `https://res.cloudinary.com/demo/video/authenticated/s--${sigAttendue}--/du_60/cm_t1.mp3`);
  // Sans transformation (chanson complète, APRÈS achat seulement) : autre signature.
  const complete = buildAudioUrl('https://res.cloudinary.com/demo/video/authenticated/cm_t1.mp3', '');
  assert.ok(!complete.includes('du_60') && complete.includes('s--'), 'signée, sans limite de durée');
  assert.notEqual(url, complete, 'retirer du_60 change la signature -> 401 chez Cloudinary');
  delete process.env.CLOUDINARY_API_SECRET;
});

test('buildAudioUrl : CLOUDINARY_SIGN_ALGO=sha256 -> signature longue 32 caractères', () => {
  process.env.CLOUDINARY_API_SECRET = 'secret-test';
  process.env.CLOUDINARY_SIGN_ALGO = 'sha256';
  const url = buildAudioUrl('https://res.cloudinary.com/demo/video/authenticated/cm_t1.mp3', 'du_60');
  const sigAttendue = createHash('sha256')
    .update('du_60/cm_t1.mp3' + 'secret-test')
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
    .slice(0, 32);
  assert.equal(url, `https://res.cloudinary.com/demo/video/authenticated/s--${sigAttendue}--/du_60/cm_t1.mp3`);
  delete process.env.CLOUDINARY_SIGN_ALGO;
  delete process.env.CLOUDINARY_API_SECRET;
});

test('buildAudioUrl : asset public (anciens tests) = URL non signée avec transformation', () => {
  const url = buildAudioUrl('https://res.cloudinary.com/demo/video/upload/cm_t2.mp3', 'du_60');
  assert.equal(url, 'https://res.cloudinary.com/demo/video/upload/du_60/cm_t2.mp3');
});
