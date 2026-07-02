// Preuve VISIBLE que le schéma est appliqué : liste tables, vues, enums et
// contraintes via information_schema / catalogues. Utilisé par :
//   - la CI de PR (Postgres éphémère, migrations depuis zéro) ;
//   - le job migrate prod (sortie lisible par Maxime après chaque migration).
// Ne journalise JAMAIS la connection string.
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL manquante.');
  process.exit(1);
}

const sql = postgres(url, { prepare: false, max: 1, ssl: url.includes('supabase.co') ? 'require' : undefined, onnotice: () => {} });

try {
  const tables = await sql`
    select table_name, table_type
    from information_schema.tables
    where table_schema = 'public' and table_name not like '__drizzle%'
    order by table_type, table_name`;
  const enums = await sql`
    select t.typname as enum_name, count(e.enumlabel)::int as valeurs
    from pg_type t join pg_enum e on e.enumtypid = t.oid
    group by t.typname order by t.typname`;
  const contraintes = await sql`
    select conrelid::regclass::text as table_name,
           count(*) filter (where contype = 'u')::int as uniques,
           count(*) filter (where contype = 'c')::int as checks,
           count(*) filter (where contype = 'f')::int as fks
    from pg_constraint
    where connamespace = 'public'::regnamespace and conrelid <> 0
    group by 1 order by 1`;
  const rls = await sql`
    select count(*)::int as sans_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and not c.relrowsecurity and c.relname not like '__drizzle%'`;

  const vraiesTables = tables.filter((t) => t.table_type === 'BASE TABLE');
  const vues = tables.filter((t) => t.table_type === 'VIEW');

  console.log('==================================================================');
  console.log(`PREUVE — schéma appliqué : ${vraiesTables.length} tables, ${vues.length} vues, ${enums.length} enums`);
  console.log('==================================================================');
  console.log('\nTABLES :');
  for (const t of vraiesTables) console.log(`  - ${t.table_name}`);
  console.log('\nVUES :');
  for (const v of vues) console.log(`  - ${v.table_name}`);
  console.log('\nENUMS :');
  for (const e of enums) console.log(`  - ${e.enum_name} (${e.valeurs} valeurs)`);
  console.log('\nCONTRAINTES PAR TABLE (uniques / checks / FKs) :');
  for (const c of contraintes) console.log(`  - ${c.table_name} : ${c.uniques} / ${c.checks} / ${c.fks}`);
  console.log(`\nRLS : ${rls[0].sans_rls === 0 ? 'activé sur TOUTES les tables ✅' : `⚠️ ${rls[0].sans_rls} table(s) SANS RLS`}`);

  if (rls[0].sans_rls !== 0) process.exit(1);
  if (vraiesTables.length === 0) {
    console.error('Aucune table : les migrations ne se sont pas appliquées.');
    process.exit(1);
  }
} finally {
  await sql.end();
}
