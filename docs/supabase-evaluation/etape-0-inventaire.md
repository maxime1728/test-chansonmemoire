# Étape 0 — Inventaire de contamination Airtable + audit Make

> Approuvé par Maxime le 2026-07-02 (avec la contre-analyse et ses 4 corrections).
> Scan exécuté sur `origin/main` (git grep), commit `64532cc`.
> Réf. : [plan-migration-supabase-v2.md](plan-migration-supabase-v2.md) §4 Étape 0.

## Chiffres globaux [Certain]

- **78 fonctions + 27 modules `_lib`** ; **74 fichiers** construisent des URLs `api.airtable.com`.
- **~145 `filterByFormula` dans 74 fichiers** : chacun devient une requête SQL typée au portage.
- `typecast: true` dans **22 fichiers** : dérive de schéma silencieuse possible à chaque écriture (disparaît avec Postgres).
- `_lib` contaminés (9/27) : comptage, courriel, cover, lexique, pub-join, purge, ranger, style, util (`formulaLiteral`).

## Verdicts transversaux [Certain]

| Vérification | Verdict |
|---|---|
| Record IDs côté client | **AUCUN** : tous les liens (courriels, URLs) passent par le `token` UUID |
| Record IDs côté admin | **OUI** : recordId Conversations = identifiant public du cockpit (`appliquer-modification`, `repondre-courriel`, `cockpit-data`, `aide-plafond`) → remplacé par l'UUID de `demandes` |
| Retries rate-limit Airtable | **AUCUN**. Seul retry du repo : Anthropic 429/5xx dans `generate-lyrics` (à CONSERVER) |
| Plafonds | `_lib/comptage.js` lit encore Generations Airtable pour compter → vue SQL `project_counts` (migration 0002), règle v2, **exemption legacy `correction_paroles_seules` NON portée** |
| Rollups/lookups Airtable lus | Aucun champ lookup « (from X) » consommé ; le comptage vit déjà en code |

## Mapping des tables Airtable réellement consommées [Certain]

| Table Airtable | ID | Cible Supabase |
|---|---|---|
| Clients | tblQbF1OlE3uRxFra | `clients` |
| Projects | tblh7O8eoog7RyTMJ | `projects` |
| Generations | tblfrHFe1zH9apNlp | `generations` |
| Conversations | tbl3KBgXthCPromxF | `conversations` + **`demandes`** (les modifs sortent du fil courriel) |
| Upsells | tbl0Z52D8l4555Has | `upsells` |
| Courriels (par nom) | — | `courriels` |
| Clics | tblD0RhAPnj4Dk3VE | Phase 3+ (analytics pubs, propre migration) |
| Pubs / Pubs_Performance | tblF68heKEIpyMuQW / tblR0fNh6mIoVlC9V | Phase 3+ (contraintes UNIQUE anti-doublons) |
| Inscriptions (séquences) | tbl8vjfRMzbbAmDO4 | `inscriptions_sequences` |
| Waitlist (par nom) | — | `waitlist` |

Nouvelles tables du plan v2 (sans équivalent Airtable) : `demandes`, `demande_analyses`,
`evenements_livraison`, `dictionnaire_prononciation`, `stripe_events`, `audit_log`.

## Inventaire par domaine

Légende : fbf×N = occurrences filterByFormula, tc = typecast. Risque en tête de section.

### A. Cœur transactionnel (élevé : argent, commande, livraison)

| Fonction | Contamination | Cible Supabase |
|---|---|---|
| soumettre-survey | Clients+Projects, fbf×2, tc, upsert courriel bricolé, branche Make si `SURVEY_DIRECT`≠1 | INSERT transactionnel, `citext unique`, branche Make supprimée |
| generate-lyrics (+ -background) | écrit Projects par recordId, fbf×4, retry Anthropic (à garder) | ligne `generations` type lyrics |
| creer-checkout | fbf×2, tc, garde 409 already_purchased | SELECT typé + contrainte |
| stripe-webhook | Projects+Upsells, fbf×1, tc×3, idempotence par drapeaux | transaction atomique + `stripe_events` UNIQUE |
| stripe-refund | fbf×1 | update + audit_log |
| accepter-livraison | fbf×2, preuve livraison en strings | update typé + `evenements_livraison` |
| telecharger | fbf×2, compteur non atomique | UPDATE atomique |
| commander-bump / creer-upsell / choix-memoire | Upsells+Projects, fbf×1 ch., tc | `upsells` en transaction |
| lancer-cadeau | fbf×2, tc | insert projet cadeau |
| desabonnement | fbf×1 | `clients.consent_status` / `marketing_optout_at` |
| lire-projet / lire-survey / lire-versions / lire-modifications | fbf×4/2/4/3 | SELECT par `token` + jointures |

### B. Génération chanson (élevé : chanson perdue = client perdu)

| Fonction | Contamination | Cible |
|---|---|---|
| lancer-chanson | fbf×3, plafond via `_lib/comptage`, **fallback Make en dur** | insert + vue `project_counts`, fallback supprimé |
| callback-chanson | fbf×1, match par scan | UPDATE par `suno_task_id` UNIQUE |
| suno-status / sentinelle-cron / alerte-cron / recovery-cron / signaler-echec | fbf×2/1/1/3/1 ; recovery = site du piège singleSelect 422 | requêtes typées ; enums Postgres |
| essayer-style / aide-plafond | fbf×1/2 | options `_lib`, plafond = vue |
| recompter-comptage | recompteur non-auth (F2 audit), probablement mort | SUPPRIMÉ (une vue n'a pas de recompteur) |

### C. Corrections / cockpit (moyen-élevé : la douleur quotidienne)

| Fonction | Contamination | Cible |
|---|---|---|
| decortique (+ -background) / demander-modif-client | fbf×1/2/2, tc | `demandes` + `analyse_ia` (format RÉEL de `_lib/analyse-modif`) |
| appliquer-modification / repondre-courriel | recordId Conversations public, tc | UUID `demandes` |
| appliquer/modif/brouillon/envoyer/cover -cron | fbf×1/2/2/1/2, scans chaque minute | requêtes SQL Phase 2 ; pgmq Phase 3+ |
| lancer-cover / callback-cover (+ `_lib/cover` fbf×7) | fbf×2/3 | `suno_task_id` UNIQUE |
| cockpit-data | fbf×8 (record du repo) | cockpit Phase 2, 1 requête jointe |
| prononciation + `_lib/lexique` | fbf×2+2, flag `LEXIQUE_PHON` | `dictionnaire_prononciation` UNIQUE(mot, contexte) |

### D. Add-ons (moyen : payé mais silencieusement échoué)

lancer/callback-instrumentale (fbf×2/2), -video-memoire (×2/4), -paroles-vivantes (×2/4),
lancer-signet (×2), phrases-signet (×1), exemple-paroles-vivantes, watchdog-cron (×1),
statut-render (zéro Airtable). Cible : `upsells.task_id` UNIQUE, watchdog = requête sur
états intermédiaires trop vieux.

### E. Souvenirs / photos (moyen)

enregistrer-memoire, ajouter/supprimer-photo-memoire, signer-upload-photo, capter-timing
(fbf×1 ch., ×2 timing) : champs typés de `projects`, médias inchangés (Cloudinary).
lister-photos = Cloudinary pur.

### F. Courriels (moyen)

courriel-achat (×2), courriel-entrant (×3, tc), repondre-courriel, mailgun-events (×2, tc×2),
nurture-cron (×1), sequences-cron (×1, tc×2), `_lib/courriel` (journal, ×2), tester-courriel
(zéro Airtable). Cible : `courriels` (+ statuts Mailgun) + `conversations` +
`inscriptions_sequences` ; events Mailgun alimentent `evenements_livraison`.

### G. Analytics / tracking (faible — Phase 3+, SAUF le transactionnel)

suivi-funnel (×1, drapeaux `capi_*_sent`), clic, insights-cron, pub-join-cron, capi-pageview
(zéro Airtable). **Nuance importante (contre-analyse)** : le tracking transactionnel
(suivi-funnel, attribution, dédup CAPI) est COUSU aux projets → il se porte dans la tranche
verticale Phase 2, en même temps que le cœur. Seuls insights-cron / pub-join (tables Pubs
autonomes) migrent en Phase 3+ dans leur propre migration.

### H. Ops / crons (faible)

canari-cron, canari-data-cron, e2e-canari-cron (×1), purge-cron + `_lib/purge` (×2),
purge-apercu, ranger-achat/ranger-cron + `_lib/ranger` (×2), rejoindre-waitlist (×3),
keepwarm-cron (zéro Airtable, disparaît avec les crons de polling).

## Audit Make (verdicts binaires) [Certain]

Rappel contexte (rectification Maxime 2026-07-02) : l'ancien système GHL + Make + un
Airtable distinct est ENCORE EN PRODUCTION (revenu). « Make mort » vaut pour le nouveau
.ca uniquement : aucun fallback Make n'y survivra au portage, et Make n'y sera jamais
réintroduit (sauf besoin exceptionnel décidé par Maxime).

| # | Occurrence | Verdict | Traitement |
|---|---|---|---|
| 1 | `lancer-chanson.js:31` : fallback `CALLBACK_CHANSON` → hook.us1.make.com | VIVANT | Portage Phase 2 : défaut = NOTRE `/api/callback-chanson` (construit depuis l'URL du site), env = override, URL Make supprimée |
| 2 | `soumettre-survey.js:17+160` : `MAKE_A_WEBHOOK_URL` + branche si `SURVEY_DIRECT`≠1 | VIVANT | Portage Phase 2 : le mode direct devient LE code, flag et branche Make supprimés |
| 3 | `sentinelle-cron.js:27` : `CALLBACK_CHANSON` sans fallback dur | dépendance env semi-bruyante | Disparaît au portage |
| 4 | `MAKE_WEBHOOK_SECRET` (7 fichiers) | PAS un lien Make (secret interne au nom hérité) | Renommé au portage |
| 5 | `MAKE_CADEAUX_WEBHOOK_URL` | MORT (remplacé par lancer-cadeau) | Retirer l'env Netlify au ménage final |
| 6 | Dossier `make/` + HANDOFF/CM_make_plan | Docs de l'ancien système .com EN PROD | **CONSERVÉ** tel quel |
| 7 | Front-end (`js/`, `*.html`) | Zéro référence Make | Rien |

Les fonctions .ca ne sont PAS modifiées avant leur portage : aucun vrai client ne passera
sur le .ca Airtable (lancement directement sur Supabase, décision 2026-07-02).

## Désaccords avec schema.sql (approuvés, appliqués dans db/schema.ts)

1. `suno_task_id` : UNIQUE partiel (pas un simple index).
2. Table `stripe_events` ajoutée (idempotence webhook par contrainte, insert AVANT traitement).
3. Vue `project_counts` réécrite sur la règle v2 de `_lib/comptage.js` (plafond 4, `admin_triggered` exclu, pré/post séparés, exemption legacy non portée).
4. `deleted_at` partout + `updated_at` (trigger) + `audit_log` (projects/upsells/demandes seulement en Phase 1) + CHECK montants >= 0.
5. Tables consommées ajoutées : `courriels`, `waitlist`, `inscriptions_sequences` (+ analytics en Phase 3+, pas dans la migration initiale).
6. Tables plan v2 ajoutées : `demandes`, `demande_analyses` (unique(demande_id, version_analyse)), `evenements_livraison`, `dictionnaire_prononciation`.
7. FK ON DELETE : `cascade` documenté sous `projects` (purge Loi 25), `restrict` clients→projects, `set null` pour la traçabilité.
8. `generation_status` : + `failed` ; `song_type` réel = `hommage` / `cadeau` (CHECK) — le « CM/CPT » du plan v2 était périmé ; types produit en CHECK (extensibles), machines à états en enum.
