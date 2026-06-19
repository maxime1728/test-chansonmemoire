# SETUP — Airtable + Make (production musicale)

Pas-à-pas pour appliquer l'architecture. **Base Airtable de TEST + scénario Make sandbox uniquement.**
Rien ici ne touche la prod. Ordre : Airtable d'abord (le pied de la chaîne), puis Make.

---

## 1. Airtable (base de test dupliquée)

### ✅ Déjà appliqué via MCP (base appIADNKzDOVtpjWj, 2026-06-19)
**Projects** : `recevoir_clicked_at`, `delivery_signature_name`, `delivery_signature_at`,
`delivery_accessed_at`, `delivery_acceptance_text_version`, `acceptance_ip`, `acceptance_user_agent`,
`downloaded_at` (dateTime/text/number).
**Generations** : `suno_task_id`, `post_purchase`.
Déjà présents avant : `token`, `cgv_acceptees_at`, `stripe_*`, `fbc/fbp`, `song_id`,
`cloudinary_audio_url`, `delivery_url`. `task_id` absent, pas de doublon `payment_intent`. Rien à nettoyer.

### ⚙️ Reste manuel dans l'UI Airtable (le MCP ne crée pas de rollup ni n'édite les options de select)
1. **Projects → `song_regenerations_count`** : Rollup sur `generations`, `COUNT(values)`,
   filtre **`suno_task_id` non vide ET `post_purchase` décoché**. (Pas besoin de toucher `type`.)
2. **Projects → `post_purchase_regenerations_count`** : Rollup sur `generations`, `COUNT(values)`,
   filtre **`suno_task_id` non vide ET `post_purchase` coché**.
3. **Generations → `generation_status`** : ajouter l'option **`audio_pending`** (garder
   `lyrics_generated` / `audio_generated` / `validated` — orthographe EXACTE, le polling l'attend).
4. *(Optionnel)* `type` : ajouter `song` / `song_regeneration` pour la lisibilité (NON requis : les
   compteurs se basent sur `suno_task_id`, pas sur `type`). Existant : `preview` / `regeneration` / `cover`.
5. *(Optionnel, cleanup)* retirer `preview_slug` / `full_slug` (redondants avec le token) ; l'ancien
   rollup `regenerations_count` peut rester (inoffensif) ou être retiré.

**Plafonds côté Make** : pré-achat `song_regenerations_count < 6` (1re + 5 régén) ;
post-achat `post_purchase_regenerations_count < 5`.

### PAT Airtable
Scopes `data.records:read` + `data.records:write`, accès à la **base de test uniquement**.
Renseigner `AIRTABLE_TOKEN` + `AIRTABLE_BASE_ID` en variables d'env Netlify.

---

## 2. Make (scénario sandbox)

### Connexions / variables (jamais en dur)
- `SUNO_API_KEY`, `ANTHROPIC_API_KEY`, connexion Airtable (base test), connexion Cloudinary.

### Ordre de montage
1. **MAKE C-cb** (callback) en premier — voir `MAKE_C-cb.json`. Crée le webhook, **copie son URL**.
2. **MAKE C-gen** (lancement) — voir `MAKE_C-gen.json`. Colle l'URL du webhook MAKE C-cb dans
   `callBackUrl` (corps HTTP de `http_bodies.json#suno_generate` / `#suno_upload_cover`).
3. **Data Store** `style × ambiance` → chaîne `style` Suno (ton mini-prompt de directives).
4. Brancher les déclencheurs front :
   - `/apercu` bouton « Régénérer » → `/souvenirs?id=TOKEN` → MAKE A (régén paroles) → `/revision` → approbation → MAKE C-gen.
   - `page-chanson` « Régénérer la chanson » / « cover » → POST direct au webhook **MAKE C-gen**
     (remplacer `MAKE_C_GEN_WEBHOOK` dans `page-chanson.html`).

### Webhooks à câbler dans le code
- `souvenirs.html` → `MAKE_WEBHOOK_A` (déjà présent).
- `page-chanson.html` → `MAKE_C_GEN_WEBHOOK` (placeholder à remplacer).

---

## 3. Tests (par irréversibilité)
1. **Lecture isolée** : créer à la main un Project (`token` UUID) + Generation `audio_generated` →
   `/apercu?id=TOKEN` joue le preview 60s.
2. **Pré-remplissage** : `/souvenirs?id=TOKEN` ré-affiche les réponses (lire-survey).
3. **Lancement chanson** : approbation `/revision` → MAKE C-gen → `suno_task_id` écrit, statut `audio_pending`.
4. **Callback** : MAKE C-cb reçoit `complete` → garde piste [0] → Cloudinary → `audio_generated` →
   `/attente` redirige vers `/apercu`.
5. **Plafond** : 6e régén chanson bloquée (compteur serveur). Paroles : illimitées.
6. **Preuve livraison** : `page-chanson` gate → signature → champs preuve écrits sur Project →
   révélation + téléchargement (log `downloaded_at`).

---

## 4. Drapeaux avant launch
- **Légal (BLOQUANT)** : texte d'acceptation / clause remboursement (LPC Québec) + divulgation IA →
  faire valider. Le code ne fait que capturer la preuve.
- **Loi 25** : rétention/purge des Projects non convertis ; signature + IP à couvrir dans la
  politique de confidentialité.
- **`lire-projet.js`** : le durcissement (UUID + échappement) vit dans la PR sécurité — s'assurer
  qu'elle est mergée.
