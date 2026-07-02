# Admin UI + UI Nathalie, stack cible, et refonte des connexions

> Suite de [`README.md`](README.md). Part du projet réel (77 fonctions, connexions
> scannées le 2026-07-01). Répond à : maquettes des deux UIs, stack à utiliser,
> et ce que « refaire mes connexions » veut dire concrètement.

---

## 1. Le principe : UNE app, deux rôles

Plutôt que deux applications, on bâtit **une seule app d'administration** (React + TypeScript)
avec **deux niveaux de permission** :

- **Rôle « ops » (Nathalie)** : gestion complète des clients de A à Z. Elle ne voit que ce
  qui sert son travail : fiches clients, projets, versions à écouter, corrections à traiter,
  conversations, livraisons, add-ons. Pas de finances brutes, pas de flags système.
- **Rôle « admin » (Maxime)** : tout ce que voit Nathalie **plus** la console système : KPIs,
  revenu, funnel, santé de la file d'attente et des crons, performance des pubs, accès direct
  aux tables, drapeaux de configuration.

Les permissions sont appliquées **côté base** (Row Level Security Postgres), pas seulement dans
l'UI : même si un écran fuit, la DB refuse les données hors-rôle. C'est un gain de sécurité que
l'admin Airtable actuel (accès par siège, tout ou rien) ne donne pas. `[Certain]`

---

## 2. UI Nathalie — gestion client A-Z (ce que montre la maquette)

Une fiche client « 360 » qui regroupe tout le cycle de vie au même endroit :

1. **En-tête client** : nom, courriel, région, statut de consentement (Loi 25), ancienneté, valeur à vie.
2. **Indicateurs** : nombre de projets, générations, dernier contact, montant d'achat.
3. **Projet actif** : statut dans le funnel, style/voix/ambiance, **jauge de plafond** (régénérations utilisées), **versions A/B écoutables** avec la version choisie mise en avant, boutons « corriger » et « approuver et envoyer ».
4. **Corrections à traiter** : la demande du client + un avant/après (barré → corrigé), boutons « ajuster » / « appliquer et relancer ».
5. **Conversation** : le fil courriel + un **brouillon de réponse suggéré**, boutons « modifier » / « envoyer ».
6. **Livraison + add-ons** : preuve de livraison (page accédée, signature électronique, téléchargement) et l'état des add-ons (vidéo souvenir, PDF, instrumentale).

C'est exactement ton cockpit actuel, élargi en un vrai poste de travail client complet.

---

## 3. UI Maxime — console admin (ce que montre la maquette)

1. **KPIs** : revenu 30 j, taux de conversion, projets actifs, ROAS pubs.
2. **Santé du système** : file d'attente (jobs en cours / échecs), canari bout-en-bout, watchdog livrables, crons planifiés. Remplace la surveillance qui vit aujourd'hui dans des courriels d'alerte et des vues Airtable.
3. **Funnel 30 j** : visites → aperçu écouté → paiement démarré → achat.
4. **Tables** : accès direct Clients / Projets / Générations / Pubs (la grille générique).
5. **Pubs** : meilleures campagnes par ROAS.
6. **Drapeaux de configuration** : `PLAFOND_V2`, `REVUE_AVANT_ENVOI`, `STATE_MOVE_PROPOSEE`… activables sans redéploiement.

---

## 4. Le stack recommandé

| Couche | Choix | Pourquoi |
|---|---|---|
| Base de données | **Supabase (Postgres)**, région Canada Central | Relationnel, contraintes, RLS, API auto, Auth incluse. Loi 25 : données au Canada `[Probable]` |
| Accès données (fonctions) | **Drizzle ORM** (TypeScript) | Requêtes typées, proche du SQL, léger. Fin de la dérive de schéma silencieuse |
| Exécution backend | **Netlify Functions en TypeScript** (inchangé) | On garde l'hébergement qui marche. Pas de Vercel |
| File d'attente | **pg-boss** (dans Postgres) ou **Inngest** | Remplace les 5 crons/minute (voir [`queue.md`](queue.md)) |
| App d'admin (les 2 UIs) | **React + TypeScript + Refine** | Refine scaffolde la grille CRUD générique par-dessus Supabase ; on code sur mesure les écrans de workflow (fiche client, cockpit). La grille gratuite, le custom là où ça compte |
| Authentification admin | **Supabase Auth** (lien magique) + rôles ops/admin | Vrai login pour Nathalie et toi. Remplace `COCKPIT_SECRET` |
| Pages funnel / marketing | **HTML statique (inchangé)** | SEO + perf. On re-pointe juste leurs appels vers les nouvelles fonctions |

Note sur « coder ma propre UI » : avec Refine tu **codes bien ta propre UI**, dans ta marque,
tes données chez toi. Refine te donne juste les primitives ingrates (tri, filtre, pagination,
édition inline) pour ne pas réinventer un moins bon Airtable. Tu passes ton énergie sur les
écrans de workflow qui te différencient. Alternative 100 % vanilla possible (comme ton cockpit
actuel) si tu préfères zéro dépendance, mais la maintenance de la grille est à ta charge.

---

## 5. « Refaire mes connexions » — ce qui change vraiment

Scan réel des connexions du projet. **Bonne nouvelle : une seule connexion change vraiment.**
Tu ne refais pas tout, tu **remplaces le moyeu** (Airtable) et tu re-pointes le reste dessus.

| Connexion | Aujourd'hui | Après | Changement |
|---|---|---|---|
| Données | **Airtable** (74 usages) | **Supabase / Postgres** | ★ Le vrai chantier |
| Paiements | Stripe (checkout, webhook, refund, prix) | Stripe | Inchangé (écrit dans Supabase) |
| Courriels sortants + entrants | Mailgun (domaines achat/support/marketing, clé de signature) | Mailgun | Inchangé (conversations en Supabase) |
| Paroles IA | Anthropic | Anthropic | Inchangé |
| Chanson / cover / instrumentale | Suno + callbacks | Suno + callbacks | Inchangé, **orchestré par la queue** |
| Audio + photos | Cloudinary | Cloudinary | Inchangé |
| Vidéo souvenir | Creatomate | Creatomate | Inchangé |
| Tracking pub | Meta CAPI + Marketing (insights) | Meta CAPI + Marketing | Inchangé (tables Pubs en Supabase, **fin des doublons**) |
| Observabilité | Sentry + Healthchecks | Sentry + Healthchecks | Inchangé |
| Automatisation | **Make** (2 références résiduelles) | — | **Retiré** (déjà éteint) |
| Accès admin | `COCKPIT_SECRET` | **Supabase Auth** (rôles) | Amélioré |

Résumé : **1 connexion remplacée, 1 retirée, ~9 conservées.** Le mot « refaire » sonne plus gros
que la réalité : le gros du travail, c'est la couche données et les requêtes, pas les intégrations
externes qui, elles, ne bougent quasiment pas.

---

## 6. Comment ça s'assemble (vue d'ensemble)

```
Pages funnel statiques (.ca)  ──►  Netlify Functions (TypeScript)  ──►  Supabase (Postgres)
   (SEO, inchangées)                     │  Drizzle ORM                     │  RLS + Auth
                                         │  pg-boss (queue)                 │  région Canada
                                         ▼                                  ▼
                        Stripe · Mailgun · Suno · Anthropic        App admin React+Refine
                        Cloudinary · Creatomate · Meta · Sentry     (Nathalie = ops, toi = admin)
```

---

## 7. Ordre de construction suggéré (pré-lancement)

1. Supabase debout + `schema.sql` raffiné + `_lib/db` (Drizzle).
2. Migrer les tables analytics (pubs) + poser la queue → valider sur du non-critique.
3. Migrer Générations (plafonds fiables) puis Clients/Projets.
4. Monter l'app admin Refine + Supabase Auth : d'abord la grille (gratuite), puis la fiche
   client 360 de Nathalie, puis la console système.
5. Basculer les pages funnel sur les nouvelles fonctions, retirer Airtable table par table.

L'inventaire fonctionnel (quels parcours marchent déjà) reste l'étape qui transforme ce plan en
échéancier ferme.
