// Tests d'INTÉGRATION du funnel v2 (survey / projet / revision-paroles) contre la
// vraie base éphémère de la CI (chemin runtime :6543, migrations déjà appliquées).
// Sans SUPABASE_DB_URL, tout est sauté (exécution locale sans base).
//
// Ce qu'on prouve : anti-bot, upsert client PAR CONTRAINTE (citext), idempotence du
// token, attribution jsonb, filtrage des réponses (pas de courriel exposé), échecs
// BRUYANTS (courriel manquant = 400, déclenchement impossible = 5xx, secret = 401).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { EvenementHttp } from '../netlify/functions/_lib/http';

const DB = process.env.SUPABASE_DB_URL || '';
const skip = DB ? false : 'SUPABASE_DB_URL absente (test CI seulement)';

// URL inaccessible : le déclenchement du background échoue VITE (personne n'écoute) ->
// on teste les deux politiques (survey = best-effort journalisé, revision = bruyant).
process.env.URL = 'http://127.0.0.1:9';

function evenement(sur: Partial<EvenementHttp>): EvenementHttp {
  return {
    httpMethod: 'POST',
    path: '/api/test',
    headers: {},
    queryStringParameters: null,
    body: null,
    ...sur,
  };
}

function corpsSurvey(token: string, email: string) {
  return JSON.stringify({
    token,
    email,
    deceased_name: 'IT-Jean Tremblay',
    relationship: 'son fils',
    music_style: 'country',
    voice: 'homme',
    mood: 'apaisante',
    what_made_unique: 'sa générosité',
    memories: 'les étés au chalet',
    memory_to_keep: 'sa joie',
    utm_source: 'facebook',
    utm_content: 'pub-test-it',
    landing_page: '/index',
    last_utm_source: 'instagram',
    fbclid: 'fb.test.123',
  });
}

test('funnel v2 : parcours soumission -> lecture -> révision (base réelle)', { skip }, async (t) => {
  const { handler: survey } = await import('../netlify/functions/survey');
  const { handler: projet } = await import('../netlify/functions/projet');
  const { handler: revision } = await import('../netlify/functions/revision-paroles');
  const { handler: background } = await import('../netlify/functions/survey-paroles-background');
  const { default: postgres } = await import('postgres');
  const sql = postgres(DB, { prepare: false, max: 1, onnotice: () => {} });

  const token = randomUUID();
  const email = `it-${token.slice(0, 8)}@exemple.ca`;

  t.after(async () => {
    await sql`delete from projects where deceased_name like 'IT-%'`;
    await sql`delete from clients where email like 'it-%@exemple.ca'`;
    await sql.end();
  });

  await t.test('anti-bot : token absent ou non-UUID = 400', async () => {
    const r1 = await survey(evenement({ body: JSON.stringify({ email }) }), {});
    const r2 = await survey(evenement({ body: JSON.stringify({ token: 'abc', email }) }), {});
    assert.equal(r1.statusCode, 400);
    assert.equal(r2.statusCode, 400);
  });

  await t.test('courriel manquant = 400 clair (jamais de projet orphelin)', async () => {
    const r = await survey(evenement({ body: JSON.stringify({ token: randomUUID() }) }), {});
    assert.equal(r.statusCode, 400);
    assert.match(r.body ?? '', /Courriel/);
  });

  await t.test('soumission valide : client + projet écrits, attribution jsonb, CGV horodatées', async () => {
    const r = await survey(evenement({ body: corpsSurvey(token, email) }), {});
    assert.equal(r.statusCode, 200, r.body ?? '');
    const [p] = await sql`select * from projects where token = ${token}`;
    assert.ok(p, 'projet créé');
    if (!p) return;
    assert.equal(p.deceased_name, 'IT-Jean Tremblay');
    assert.equal(p.funnel_step, 'survey_submitted');
    assert.ok(p.cgv_acceptees_at, 'CGV horodatées serveur');
    assert.equal(p.attribution.first.source, 'facebook');
    assert.equal(p.attribution.first.content, 'pub-test-it');
    assert.equal(p.attribution.last.source, 'instagram');
    assert.equal(p.attribution.fbclid, 'fb.test.123');
    const [c] = await sql`select * from clients where id = ${p.client_id}`;
    assert.ok(c, 'client lu');
    if (!c) return;
    assert.equal(String(c.email).toLowerCase(), email);
    assert.ok(c.consent_date, 'consentement daté');
  });

  await t.test('idempotence : même token resoumis = 200, toujours UN seul projet', async () => {
    const r = await survey(evenement({ body: corpsSurvey(token, email) }), {});
    assert.equal(r.statusCode, 200);
    const n = await sql`select count(*)::int as n from projects where token = ${token}`;
    assert.equal(n[0]?.n, 1);
  });

  await t.test('citext : même courriel en MAJUSCULES = MÊME client, pas de doublon', async () => {
    const token2 = randomUUID();
    const r = await survey(evenement({ body: corpsSurvey(token2, email.toUpperCase()) }), {});
    assert.equal(r.statusCode, 200);
    const clients = await sql`select count(*)::int as n from clients where email = ${email}`;
    assert.equal(clients[0]?.n, 1, 'un seul client malgré la casse');
    const projets = await sql`select count(distinct client_id)::int as n from projects where token in (${token}, ${token2})`;
    assert.equal(projets[0]?.n, 1, 'les deux projets pointent le même client');
  });

  await t.test('GET /api/projet : réponse filtrée, jamais le courriel', async () => {
    const mauvais = await projet(evenement({ httpMethod: 'GET', queryStringParameters: { id: 'zzz' } }), {});
    assert.equal(mauvais.statusCode, 400);
    const inconnu = await projet(evenement({ httpMethod: 'GET', queryStringParameters: { id: randomUUID() } }), {});
    assert.equal(inconnu.statusCode, 404);
    const ok = await projet(evenement({ httpMethod: 'GET', queryStringParameters: { id: token } }), {});
    assert.equal(ok.statusCode, 200);
    const corps = JSON.parse(ok.body ?? '{}');
    assert.equal(corps.prenom, 'IT-Jean Tremblay');
    assert.equal(corps.a_paroles, false);
    assert.equal(corps.generation_no, 0);
    assert.equal(corps.etape, 'survey_submitted');
    assert.ok(!(ok.body ?? '').includes(email), 'le courriel ne sort JAMAIS par ce endpoint');
    assert.ok(!(ok.body ?? '').includes('chalet'), 'les souvenirs bruts ne sortent pas non plus');
  });

  await t.test('revision-paroles : introuvable = 404 ; déclenchement impossible = échec BRUYANT (500)', async () => {
    const inconnu = await revision(evenement({ body: JSON.stringify({ token: randomUUID(), modifications: 'x' }) }), {});
    assert.equal(inconnu.statusCode, 404);
    const echec = await revision(evenement({ body: JSON.stringify({ token, modifications: 'Parlez du chalet' }) }), {});
    assert.equal(echec.statusCode, 500, 'URL background inaccessible -> 500 explicite, pas une attente infinie');
  });

  await t.test('background : secret exigé (401), token validé (400), clé API absente = échec fort (500)', async () => {
    const sansSecret = await background(evenement({ body: JSON.stringify({ token, secret: 'mauvais' }) }), {});
    assert.equal(sansSecret.statusCode, 401);
    const mauvaisToken = await background(evenement({ body: JSON.stringify({ token: 'abc', secret: 'secret-ci' }) }), {});
    assert.equal(mauvaisToken.statusCode, 400);
    delete process.env.ANTHROPIC_API_KEY;
    const sansCle = await background(evenement({ body: JSON.stringify({ token, secret: 'secret-ci' }) }), {});
    assert.equal(sansCle.statusCode, 500, 'clé manquante = P1 + 500, jamais un succès silencieux');
  });
});
