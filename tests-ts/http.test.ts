// Tests du wrapper d'erreur commun (_lib/http.ts) : le contrat anti-bug-silencieux.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avecErreurs, type EvenementHttp } from '../netlify/functions/_lib/http';
import { nettoyer } from '../netlify/functions/_lib/journal';

const evenement: EvenementHttp = {
  httpMethod: 'GET',
  path: '/api/test?id=123e4567-e89b-4d3c-8456-426614174000',
  headers: {},
  queryStringParameters: null,
  body: null,
};

test('une exception devient un 500 générique, jamais une fuite de détail', async () => {
  const gestionnaire = avecErreurs('test', async () => {
    throw new Error('secret interne : client@exemple.ca');
  });
  const reponse = await gestionnaire(evenement, {});
  assert.equal(reponse.statusCode, 500);
  const corps = JSON.parse(reponse.body ?? '{}');
  assert.equal(corps.error, 'Erreur interne');
  assert.ok(!(reponse.body ?? '').includes('client@exemple.ca'), 'le détail interne ne doit pas fuiter');
});

test('le chemin nominal passe tel quel', async () => {
  const gestionnaire = avecErreurs('test', async () => ({
    statusCode: 200,
    body: JSON.stringify({ ok: true }),
  }));
  const reponse = await gestionnaire(evenement, {});
  assert.equal(reponse.statusCode, 200);
  assert.equal(JSON.parse(reponse.body ?? '{}').ok, true);
});

test('une erreur retournée en 200 est interdite par contrat, pas par magie : un 500 explicite est journalisé sans être réécrit', async () => {
  const gestionnaire = avecErreurs('test', async () => ({
    statusCode: 503,
    body: JSON.stringify({ error: 'dépendance en panne' }),
  }));
  const reponse = await gestionnaire(evenement, {});
  assert.equal(reponse.statusCode, 503, 'le wrapper journalise le 5xx mais respecte la réponse du handler');
});

test('le chemin journalisé est nettoyé (pas de token dans les logs)', async () => {
  const lignes: string[] = [];
  const erreurOriginal = console.error;
  console.error = (l: string) => {
    lignes.push(String(l));
  };
  try {
    const gestionnaire = avecErreurs('test', async () => {
      throw new Error('boum');
    });
    await gestionnaire(evenement, {});
  } finally {
    console.error = erreurOriginal;
  }
  const journal = lignes.join('\n');
  assert.ok(journal.length > 0, 'une ligne P1 doit être journalisée');
  assert.ok(!journal.includes('123e4567'), 'le token du chemin ne doit pas apparaître dans les logs');
});

test('nettoyer() efface tokens, UUID et courriels des logs', () => {
  const sale = 'echec /apercu?id=123e4567-e89b-4d3c-8456-426614174000 pour client@exemple.ca (uuid 123e4567-e89b-4d3c-8456-426614174000)';
  const propre = nettoyer(sale);
  assert.ok(!propre.includes('123e4567'), 'UUID effacé');
  assert.ok(!propre.includes('client@exemple.ca'), 'courriel effacé');
  assert.ok(propre.includes('REDACTED'));
});
