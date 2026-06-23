# LAUNCH — Chanson Mémoire · checklist de mise en production

> État au 2026-06-22. Cocher au fur et à mesure. Légende : 🔴 bloqueur · 🟡 important · 🟢 souhaitable (post-launch OK) · ✅ fait.
> Détail technique dans `HANDOFF.md` + la mémoire auto.

---

## 🔴 BLOQUEURS — à régler avant d'ouvrir au public

### Paiement (Stripe TEST → LIVE)
- [ ] Clé **live** dans `STRIPE_SECRET_KEY` (Netlify) — remplace la clé restreinte test.
- [ ] Prix **`price_…` LIVE** dans `STRIPE_PRICE_SONG` / `STRIPE_PRICE_INSTRUMENTAL` / `STRIPE_PRICE_PAROLES_VIVANTES` (recréer les 3 prix en mode live).
- [ ] **MAKE D** (webhook achat) : clé Stripe **live** (module 2) + webhook abonné au compte live.
- [ ] **Taxes** : Stripe Tax actif en live (OK) ; décider si on ajoute `automatic_tax` au checkout par-version (`creer-checkout`).
- [ ] Test : 1 vrai achat live (petit montant) → `purchased` + livraison + courriel.

### Livraison — ne rien vendre qu'on ne livre pas
- [x] **Chanson** (Cloudinary signé, download).
- [ ] **Cadeau paroles PDF** — valider au déploiement (rendu pdfkit + upload Cloudinary). *(bâti)*
- [ ] **Instrumentale** — finaliser : `SUNO_API_KEY` (Netlify) + déclencheur MAKE D (HTTP `lancer-instrumentale`) + ré-héberger sur Cloudinary (URLs Suno expirent). *(moteur bâti)*
- [ ] **Paroles vivantes en vidéo** — ❌ pas bâti : décider l'outil de génération **OU** retirer ce bump/upsell au lancement.
- [ ] **Mailgun** — config des clés (`MAILGUN_API_KEY` / `_DOMAIN` / `_FROM`) → active les courriels (cadeau, décortique).

### Légal — BLOQUANT, validation par un pro (Loi 25 / protection conso / concurrence)
- [ ] **CGV** : consentement, **divulgation IA au point d'achat**, droit de résolution (LPC), politique de remboursement.
- [ ] **Loi 25** : consentement (incl. transfert Meta/CAPI), rétention + divulgation des données perso (`acceptance_ip`, email, `cgv_acceptees_at`…), minimisation.
- [ ] **Prix / taxes** : affichage clair ; aucun prix barré ou « avant/après » non substantié.
- [ ] **Aucun témoignage / avis / allégation de résultat fabriqué** — audit du copy en prod.

### Tests
- [ ] **Chaîne complète end-to-end** (Maxime) : survey → paroles → chanson → achat → page-memoire → cadeau + instrumentale + upsell. Inclure les déclencheurs (`lancer-cadeau`, `lancer-instrumentale`) + la sentinelle + l'alerte 10 h.

---

## 🟡 IMPORTANT — idéalement avant, sinon juste après
- [ ] **CAPI Purchase + Lead** (attribution pubs Meta) : Purchase au moment de l'achat (déclenché par MAKE D), Lead à la génération des paroles (MAKE A). Token-safe, email haché. *(je peux le bâtir, réutilise l'infra de `suivi-funnel`)*
- [ ] **Boucle décortique** (modifications post-achat) : courriel Mailgun ↔ réponse → Suno `upload-cover` → approbation → publication. *(attend Mailgun)*
- [ ] **Sécurité** : re-confirmer le flag « énumération clients » (audité : seul `generate-lyrics` avait une vraie faille, corrigée) avant launch.
- [ ] **Nettoyage Make** : désactiver l'ancien scénario **Cadeaux 4794401** (remplacé par `lancer-cadeau`) + retirer l'env `MAKE_CADEAUX_WEBHOOK_URL`.

---

## 🟢 SOUHAITABLE — post-lancement OK
- [ ] **Signets v2** (PDF commémoratif + QR vers la chanson) — auto-codé comme le cadeau (plus de Canva).
- [ ] **Finition PDF** : embarquer les polices exactes (Cormorant / Fraunces) — v1 = Times, très proche.
- [ ] **Ré-héberger Cloudinary** l'instrumentale (durcissement).

---

## ✅ DÉJÀ EN PLACE
- Parcours complet (survey → paroles → chanson Suno → callback → Cloudinary → aperçu signé).
- Achat par version (`creer-checkout`) + livraison (MAKE D, testé en test).
- Page acceptation (`page-chanson`) + page de livraison (`page-memoire`).
- **Order bumps** sur la page de confirmation + **upsell post-achat** (mécanique de vente).
- **Cadeau paroles PDF** généré côté serveur (pdfkit, sans Canva) + affiché sur le site + courriel prêt (Mailgun).
- **Instrumentale** : moteur Suno vocal-removal (requête + callback) bâti.
- Décortique (analyse Claude, 5 catégories) ; plafond + popup ; CAPI PreviewPlayed + InitiateCheckout (serveur, token-safe).
- Robustesse : auto-relance des paroles (revision), popup d'attente 8 min, **sentinelle** + **alerte 10 h** (actives).

---

## 🔑 Variables d'env Netlify au lancement (récap)
`AIRTABLE_BASE_ID`, `AIRTABLE_TOKEN`, `ANTHROPIC_API_KEY`, `CLOUDINARY_CLOUD_NAME`/`_API_KEY`/`_API_SECRET`, `STRIPE_SECRET_KEY` (**live**), `STRIPE_PRICE_SONG`/`_INSTRUMENTAL`/`_PAROLES_VIVANTES` (**price_… live**), `META_CAPI_TOKEN`, `META_DATASET_ID`, `SUNO_API_KEY` (instrumentale), `MAILGUN_API_KEY`/`_DOMAIN`/`_FROM` (courriels).
