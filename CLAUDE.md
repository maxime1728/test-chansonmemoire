# CLAUDE.md — Chanson Mémoire (CM)

> Contexte permanent lu automatiquement par Claude Code à la racine du repo.
> **Règle d'or :** si une demande ponctuelle entre en conflit avec une consigne ici
> (surtout sections 2 et 3), **arrête-toi et demande confirmation explicite** avant d'agir.

---

## 1. Ce qu'est CM

Chansons hommage/commémoratives générées par IA, ~139,97 $ CAD. Produit digital livré.
Marché B2C **Québec francophone** (deuil, commémoration). Opéré sous LabMarketing.

**Équipe & handoffs :**
- **Maxime** — stratégie + build. Seul à promouvoir en prod.
- **Freelancer** (part-time) — exécution backend, **propriétaire de la base Airtable de prod**.
- **Brigitte** — non-technique, relation client. Aucun changement technique ne doit dépendre d'elle.

**Voix de marque (NON négociable) :**
- Identité québécoise assumée.
- **SOLUTION-FIRST** : ne JAMAIS ouvrir un copy sur le deuil ou la douleur. On entre par
  ce qu'on offre (garder une voix, un souvenir vivant), jamais par la perte.
- Palette mauve / papier pâle. Ton sobre, digne, pas larmoyant.

---

## 2. Garde-fous légaux (BLOQUANTS)

Tout livrable légal est un **point de départ à faire valider** — jamais un avis juridique.

Si une tâche touche **le prix, les témoignages, ou les allégations de résultats : STOP** et
signale la conformité avant de produire. Historique de violations corrigées — ne pas répéter.

- **Loi 25** (consentement, vie privée) : la preuve de consentement (`cgv_acceptees_at`) et la
  minimisation des données exposées sont des contraintes de design, pas des détails.
- **Loi sur la concurrence** : aucun prix de référence / prix barré non substantié.
- **Protection du consommateur** + **divulgation IA au point d'achat** : à maintenir dans
  tout copy/funnel généré.
- **Ne JAMAIS fabriquer** : témoignages, avis clients, prix de référence, allégations de résultats.

---

## 3. Credentials & périmètre (DO-NOT-TOUCH)

Principe : l'agent opère sur **test/preview avec credentials révocables**. Maxime seul promeut en prod.

- **Stripe** — jamais la clé secrète *live*. Test mode + clé restreinte uniquement.
- **Airtable** — base de **test dupliquée** seulement. **Ne jamais écrire dans la base CM de prod**
  (gérée par le freelancer). En cas de doute sur la base ciblée : demander.
- **Netlify** — branch/preview deploys. Pas de push direct en prod.
- **GitHub** — toujours sur **branche + PR**. Jamais de commit direct sur `main`.
- **Make** — scénario **sandbox dupliqué**. Jamais le flux live.
- **Secrets** — ne jamais committer `.env`, clés, tokens ou PII dans le repo. Vérifier avant chaque commit.

> Les MCP connectés (Airtable, Stripe, Make, Netlify) facilitent les **propositions** ;
> toute action à effet de bord en prod passe par un humain.

---

## 4. Domaines

- `chansonmemoire.ca` = Canada/Québec. **Défaut pour TOUTE URL, lien canonique, redirection, config.**
- `chansonmemoire.com` = réservé Europe (phase future). **Ne jamais l'utiliser par défaut.**

---

## 5. Périmètre de Claude Code

**Territoire repo (autonomie OK sur branche) :**
- Pages HTML statiques (survey, waiting, payment, `souvenirs.html`, `revision.html`)
- Netlify Functions (`lire-projet.js` et suivantes)
- Wiring du token routing `?id=TOKEN` dans les pages
- Hardening sécurité du endpoint de lecture
- `netlify.toml`, conventions, env vars (références, pas de valeurs)

**MCP-assisté (proposer → humain valide et applique) :**
- Airtable : proposer schéma/changements **sur base de test**
- Make : générer un blueprint JSON ; le debug visuel reste humain
- Stripe / Netlify : lecture seule ou test mode

**Interdit (humain seulement) :** Stripe live, Make prod, schéma Airtable prod, Meta Ads, GHL.

---

## 6. Décisions lockées (ne pas re-litiger)

- **Token routing** : `crypto.randomUUID()` généré au load de la page survey, passé en `?id=TOKEN`
  sur toutes les pages, écrit dans Project par Make. Remplace `sessionStorage` (fragile : casse au
  changement d'onglet/appareil/lien email — failure modes critiques pour un produit mémoriel).
- **Séparation lecture/écriture** : **Make écrit, Netlify lit.** Élimine la race condition
  Netlify↔Make. (Make facture par opération ; lectures Netlify ~gratuites à l'échelle CM.)
- **Endpoint Netlify** : expose seulement `titre / paroles / statut / audio_url / suggestions / commercial_status`.
  (`suggestions` = JSON string des bulles dynamiques, exposition intentionnelle.)
  **Jamais** email, Stripe IDs, ou données d'attribution.
- **Anthropic** : 1 seul call consolidé → `{"titre": "...", "paroles": "..."}` JSON.
- **Schéma Airtable canonique** : 4 tables (Clients, Projects, Generations, Upsells).
  Référence autoritaire : `CM_mapping_airtable.md`.

---

## 7. Inventaire fichiers (repo)

- `souvenirs.html`, `revision.html` — livrés corrigés.
- `netlify/functions/lire-projet.js` — livré corrigé (exposition minimale, voir §6).
- `netlify.toml` — **configuré correctement, ne pas modifier sans raison.**
- Pages survey / waiting / payment — migration GHL legacy → HTML statique en cours.

---

## 8. Conventions de travail

- Travailler par **petites PR** scopées. Décrire le « pourquoi », pas seulement le « quoi ».
- Pour tout changement à effet de bord (DB, paiement, déploiement) : **proposer un diff, attendre le go.**
- Respecter la voix de marque (§1) dans tout copy généré, sans exception.
- Quand un changement repo nécessite une action côté freelancer (schéma Airtable, etc.),
  le **dire explicitement** comme handoff, ne pas le simuler.

---

## 9. Docs de référence (à garder dans le repo)

- `CM_mapping_airtable.md` — schéma Airtable autoritaire.
- `CM_make_plan.md` — plan Make Scénarios A→D, jonctions de test, règles sécurité, flags Loi 25, checklist.

---

## 10. Sécurité — flag ouvert (haute priorité)

Les pages de livraison **basées sur slug** risquent l'énumération clients (exposition de chansons
privées d'autres familles). Le token routing adresse **partiellement** le problème.
**Audit de sécurité complet requis avant launch.** Ne pas considérer comme réglé.
