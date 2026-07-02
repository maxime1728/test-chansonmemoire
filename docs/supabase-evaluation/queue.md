# Prototype : remplacer les 5 crons/minute par une vraie file d'attente

## Le problème actuel

Cinq fonctions tournent **chaque minute** pour simuler une file de traitement :

| Cron (chaque minute) | Ce qu'il fait vraiment |
|---|---|
| `cover-cron` | Cherche les covers à lancer/relancer |
| `envoyer-cron` | Cherche les courriels à envoyer |
| `brouillon-cron` | Cherche les brouillons à préparer |
| `modif-cron` | Cherche les modifications à router |
| `appliquer-cron` | Cherche les corrections à appliquer |

Coût de ce seul motif : `5 × 60 × 24 × 30 ≈ 216 000` invocations/mois `[Certain]`, dont la quasi-totalité ne trouve **rien à faire** (polling à vide). Et latence : jusqu'à **60 s** avant qu'un job démarre.

C'est le symptôme classique de « la DB n'a pas de mécanisme de job, donc on scanne en boucle ». Une vraie queue transforme ça en **réactif** (le job démarre à la milliseconde où il est créé), avec **retry natif** et **observabilité**.

> Point clé : cette amélioration est **orthogonale** à Airtable→Supabase. Tu pourrais l'adopter même en restant sur Airtable. Mais avec Postgres elle devient quasi gratuite (`pg-boss` vit dans ta DB).

## Deux options

| | **pg-boss** (recommandé si Supabase) | **Inngest / Trigger.dev** (SaaS) |
|---|---|---|
| Où | Dans ton Postgres Supabase | Service externe |
| Coût | Inclus (c'est ta DB) | Free tier puis payant |
| Observabilité | À construire (SQL) | Dashboard, retries, logs inclus ★ |
| Dépendance externe | Aucune ★ | Une de plus |
| Idéal si | Tu veux une stack auto-contenue | Tu veux voir/rejouer les jobs sans coder |

Mon choix pour ton profil : **pg-boss** pour rester auto-contenu, OU **Inngest** si tu veux un tableau de bord des jobs sans rien bâtir. `[Recommandation]`

## Esquisse pg-boss

```js
// _lib/queue.js — une seule connexion partagée
const PgBoss = require('pg-boss');
let boss;
async function getBoss() {
  if (boss) return boss;
  boss = new PgBoss(process.env.SUPABASE_DB_URL);   // même Postgres que l'app
  await boss.start();
  return boss;
}
module.exports = { getBoss };
```

```js
// Producteur : au lieu d'écrire un flag "à traiter" qu'un cron ira scanner,
// on POUSSE le job. Ex. dans lancer-cover.js, après avoir lancé Suno :
const { getBoss } = require('./_lib/queue');
await (await getBoss()).send('cover', { projectId, generationNo });
```

```js
// Worker : une fonction Netlify -background (ou un petit service) qui consomme.
// Remplace cover-cron. Zéro polling à vide, retry automatique.
const { getBoss } = require('./_lib/queue');
exports.handler = async () => {
  const boss = await getBoss();
  await boss.work('cover', { teamSize: 2 }, async (job) => {
    const { projectId, generationNo } = job.data;
    // ... la logique actuelle de cover-cron, mais pour CE job précis ...
  });
  return { statusCode: 200, body: 'ok' };
};
```

pg-boss gère : retry avec backoff, jobs planifiés (`sendAfter`), déduplication (`singletonKey`), archivage. `singletonKey` remplacerait par exemple tes drapeaux d'idempotence `capi_*_sent`.

## Ce qui reste en cron (et c'est correct)

Tous les crons ne sont pas des files déguisées. Ceux-ci restent des tâches planifiées légitimes (via `pg_cron` dans Supabase, ou crons Netlify) :

- Monitoring : `canari-cron`, `canari-data-cron`, `e2e-canari-cron`, `sentinelle-cron`, `alerte-cron`, `watchdog-cron`
- Périodique métier : `nurture-cron`, `sequences-cron`, `recovery-cron`, `insights-cron`, `pub-join-cron`, `purge-cron`
- `keepwarm-cron` : **disparaît** si les workers ne sont plus des fonctions à cold-start.

## Gain net

- ~216k invocations/mois de polling à vide → ~0.
- Latence de démarrage d'un job : 60 s → quasi instantané.
- Retry / reprise sur échec : bricolé aujourd'hui → natif.
- Les drapeaux `_sent` et le recomptage manuel → remplacés par la sémantique de la queue.
