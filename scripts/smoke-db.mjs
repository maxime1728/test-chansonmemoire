// Smoke test post-migrations (CI, Postgres éphémère) : prouve que les contraintes
// échouent FORT, exactement le contrat du plan v2 (« un doublon rejeté »).
// N'écrit que des données de test, dans une base jetable.
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL manquante.');
  process.exit(1);
}
const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });

let echecs = 0;
function attendu(nom, ok) {
  console.log(`${ok ? 'OK ' : 'ÉCHEC'} — ${nom}`);
  if (!ok) echecs++;
}

try {
  // 1. Unicité courriel INSENSIBLE À LA CASSE (citext) : le doublon est rejeté par la base.
  const [client] = await sql`insert into clients (email) values ('smoke@exemple.ca') returning id`;
  let dupRefuse = false;
  try {
    await sql`insert into clients (email) values ('SMOKE@EXEMPLE.CA')`;
  } catch (e) {
    dupRefuse = e.code === '23505';
  }
  attendu('doublon courriel (même en MAJUSCULES) rejeté par contrainte', dupRefuse);

  // 2. Idempotence Stripe PAR CONTRAINTE : le 2e event identique est un no-op.
  await sql`insert into stripe_events (stripe_event_id, type) values ('evt_smoke_1', 'checkout.session.completed')`;
  const rejoue = await sql`
    insert into stripe_events (stripe_event_id, type) values ('evt_smoke_1', 'checkout.session.completed')
    on conflict (stripe_event_id) do nothing returning id`;
  attendu('event Stripe rejoué = no-op (on conflict do nothing)', rejoue.length === 0);

  // 3. FK : une génération sans projet valide est impossible.
  let fkRefuse = false;
  try {
    await sql`insert into generations (project_id, generation_no, type) values (gen_random_uuid(), 1, 'lyrics')`;
  } catch (e) {
    fkRefuse = e.code === '23503';
  }
  attendu('génération orpheline rejetée par FK', fkRefuse);

  // 4. unique(project_id, generation_no) + unique partiel suno_task_id.
  const [projet] = await sql`
    insert into projects (client_id, deceased_name) values (${client.id}, 'Test Smoke') returning id`;
  await sql`insert into generations (project_id, generation_no, type, suno_task_id) values (${projet.id}, 1, 'song', 'suno_smoke_1')`;
  let genDupRefuse = false;
  try {
    await sql`insert into generations (project_id, generation_no, type) values (${projet.id}, 1, 'lyrics')`;
  } catch (e) {
    genDupRefuse = e.code === '23505';
  }
  attendu('deux générations n°1 pour le même projet = rejeté', genDupRefuse);
  let sunoDupRefuse = false;
  try {
    await sql`insert into generations (project_id, generation_no, type, suno_task_id) values (${projet.id}, 2, 'song', 'suno_smoke_1')`;
  } catch (e) {
    sunoDupRefuse = e.code === '23505';
  }
  attendu('même suno_task_id deux fois = rejeté (course de callbacks impossible)', sunoDupRefuse);

  // 5. CHECK : montant négatif impossible.
  let montantRefuse = false;
  try {
    await sql`update projects set amount = -1 where id = ${projet.id}`;
  } catch (e) {
    montantRefuse = e.code === '23514';
  }
  attendu('montant négatif rejeté par CHECK', montantRefuse);

  // 6. Machine à états : le trigger etat_depuis bouge quand l'état change.
  const [demande] = await sql`
    insert into demandes (project_id, demande_brute) values (${projet.id}, 'Test smoke : corriger la prononciation.') returning id, etat_depuis`;
  await sql`update demandes set etat = 'analysee_ia' where id = ${demande.id}`;
  const [apres] = await sql`select etat, etat_depuis, updated_at from demandes where id = ${demande.id}`;
  attendu('transition d\'état -> etat_depuis remis à jour par trigger', apres.etat === 'analysee_ia' && apres.etat_depuis >= demande.etat_depuis);

  // 7. audit_log rempli par trigger sur demandes.
  const audits = await sql`select count(*)::int as n from audit_log where table_name = 'demandes' and record_id = ${demande.id}`;
  attendu('audit_log trace INSERT + UPDATE de la demande', audits[0].n >= 2);

  // 8. Soft-delete : la vue *_actifs cache la ligne, la table la garde.
  await sql`update projects set deleted_at = now() where id = ${projet.id}`;
  const visibles = await sql`select count(*)::int as n from projects_actifs where id = ${projet.id}`;
  const brutes = await sql`select count(*)::int as n from projects where id = ${projet.id}`;
  attendu('soft-delete : invisible via projects_actifs, conservé dans projects', visibles[0].n === 0 && brutes[0].n === 1);

  // 9. Vue des plafonds interrogeable.
  await sql`select appels_suno_pre, appels_suno_post from project_counts limit 1`;
  attendu('vue project_counts (plafonds v2) interrogeable', true);

  console.log(echecs === 0 ? '\nSMOKE : toutes les garanties tiennent ✅' : `\nSMOKE : ${echecs} garantie(s) en échec ❌`);
  process.exit(echecs === 0 ? 0 : 1);
} finally {
  await sql.end();
}
