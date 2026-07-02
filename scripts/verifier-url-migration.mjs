// Garde-fou de la connection string de MIGRATION (job migrations-prod).
// Attrape AVANT drizzle-kit les erreurs de collage du secret, avec un message clair
// (drizzle renvoie sinon un « TypeError: Invalid URL » illisible). Ne journalise
// JAMAIS la valeur du secret : uniquement des diagnostics sur sa forme.
const u = process.env.DATABASE_URL || '';

function echec(msg) {
  console.error(`ERREUR secret SUPABASE_DB_URL_DIRECT : ${msg}`);
  console.error(
    'Attendu : une URI complète copiée depuis Supabase -> bouton « Connect » -> ' +
      '« Session pooler » (port 5432), de la forme ' +
      'postgresql://postgres.<ref>:MOTDEPASSE@aws-...pooler.supabase.com:5432/postgres',
  );
  console.error(
    'Rappels : (1) remplacer [YOUR-PASSWORD] par le vrai mot de passe ; ' +
      '(2) si le mot de passe contient @ : / ? # & ou un espace, l\'encoder en %XX ' +
      '(ex. @ -> %40) OU réinitialiser le mot de passe pour n\'avoir que lettres/chiffres ' +
      '(Supabase -> Settings -> Database -> Reset database password) ; ' +
      '(3) pas de guillemets ni d\'espace autour de la valeur.',
  );
  process.exit(1);
}

if (!u) echec('secret vide ou absent dans l\'Environment production-db.');
if (/\s/.test(u)) echec('la valeur contient une espace ou un saut de ligne.');
if (u.includes('[') || u.includes(']')) {
  echec('un gabarit non remplacé subsiste (crochets [ ]), ex. [YOUR-PASSWORD].');
}
if (u.includes(':6543')) {
  echec('pooler TRANSACTION détecté (port 6543). Les migrations exigent le port 5432 (session pooler ou directe).');
}
// Une URI valide a EXACTEMENT un '@' (séparateur identifiants/hôte). Plusieurs '@'
// = un '@' non encodé dans le mot de passe : new URL() ne plante pas mais tronque
// silencieusement le mot de passe -> échec d'auth plus loin. On l'attrape ici.
if ((u.match(/@/g) || []).length !== 1) {
  echec('plusieurs « @ » détectés : le mot de passe contient probablement un « @ » non encodé (l\'encoder en %40) ou réinitialiser le mot de passe.');
}

let parsed;
try {
  parsed = new URL(u);
} catch {
  echec('la valeur n\'est pas une URL analysable (souvent : caractère spécial non encodé dans le mot de passe).');
}

if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
  echec(`protocole « ${parsed.protocol} » inattendu (attendu postgres:// ou postgresql://).`);
}
if (parsed.port && parsed.port !== '5432') {
  echec(`port ${parsed.port} inattendu pour une connexion de migration (attendu 5432).`);
}

console.log(`Connexion de migration OK : hôte ${parsed.hostname}, port ${parsed.port || '5432'}, base ${parsed.pathname.slice(1) || 'postgres'}.`);
