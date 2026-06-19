# **CM — Plan Make complet (scénarios, sécurité, Loi 25\)**

Relu depuis le début de la conversation. Architecture arrêtée : **token généré dans le survey**, **Make orchestre** (création client/projet \+ génération paroles), **Netlify lit** (fonction `lire-projet`, gratuit \+ rapide), polling sur les pages d'attente.

**Principe de séquençage : on teste par ordre d'irréversibilité, pas par ordre de page.** Si le pied de la chaîne casse, rien d'autre ne marche.

---

## **Vue d'ensemble du flux**

```
INDEX (trafic Meta)
  └─ capture fbclid / _fbp / _fbc / utm  (cookies + params URL)

SURVEY (souvenirs.html)
  ├─ génère token = crypto.randomUUID()
  ├─ POST → MAKE A  (données + token + attribution + consentement)
  └─ redirect → /revision?id=TOKEN

MAKE A  (séquentiel, un seul scénario)
  1. Webhook
  2. Upsert Client (par email)            → récupère Client Record ID
  3. Create Project (token, données, attribution, consentement)
  4. HTTP → Anthropic API (paroles + titre)
  5. Parse JSON
  6. Create Generation (lyrics, status=lyrics_generated)

/revision?id=TOKEN
  └─ polling → /api/lire-projet → affiche dès status=lyrics_generated
     ├─ client confirme            → MAKE B
     └─ client demande des modifs  → MAKE B (regeneration)

MAKE B  (paroles — NON plafonné)
  → si confirmé : déclenche MAKE C-gen (Suno)
  → si modifs   : nouvelle Generation (type=lyrics_regeneration) → retour /revision

MAKE C-gen  (lancement chanson — plafond 5)
  → Filter compteur < 5 → Data Store (style) → Suno generate (V5_5) → stocke suno_task_id

MAKE C-cb  (callback Suno — async)
  → callbackType=complete → match suno_task_id → garde piste [0]
  → upload Cloudinary → cloudinary_audio_url + song_id → status=audio_generated

/apercu?id=TOKEN  (preview 60s tronqué + Stripe Checkout)
  ├─ AperÇu audio (piste [0], 60s) + bouton payer (139,97 $) + order bumps
  └─ « Régénérer » (confirmation) → formulaire pré-rempli (lire-survey) → plafond 5

MAKE D  (webhook Stripe — la chaîne argent)
  → commercial_status=purchased, purchase_date, amount, stripe_payment_intent
  → Meta CAPI (Purchase, avec fbc/fbp)
  → courriel de livraison

/page-chanson?id=TOKEN  (livraison + révisions post-achat, plafond 5 séparé)
  ├─ gate « Recevoir ma chanson » → signature → accepter-livraison.js (preuve) → révèle
  └─ 3 actions : régén paroles / régén chanson / cover (décortique Anthropic)
/page-memoire?id=TOKEN  (livraison finale, partage famille) — lecture UNIQUE, pas de polling
```

---

## **MAKE A — Création (le scénario qu'on monte en premier)**

| \# | Module | Action | Mapping clé |
| ----- | ----- | ----- | ----- |
| 1 | **Webhook** | Reçoit le POST du survey | Payload : token, prenom\_defunt, relation, style\_musical, voix, ambiance, unicite, souvenirs, souvenir\_garder, email, consentement, fbclid, fbp, fbc, utm\_\*, landing\_page |
| 2 | **Airtable › Upsert a Record** | Table **Clients**, clé de recherche \= `email` | `email`, `contact_first_name`, `consent_status`\=`received`, `consent_date`\=`now()`, `last_activity_date`\=`now()`. → **récupère le Record ID** |
| 3 | **Airtable › Create a Record** | Table **Projects** | `client` \= **\[Record ID de l'étape 2\]** · `token` \= `{{1.token}}` · champs survey · `commercial_status`\=`preview_only` · `occasion`\=`memorial` · attribution (utm/fbclid/fbc/fbp/landing\_page) · **`cgv_acceptees_at`\=`now()`** · → **récupère le Project Record ID** |
| 4 | **HTTP › Make a request** | POST `https://api.anthropic.com/v1/messages` | Voir bloc API ci-dessous |
| 5 | **JSON › Parse JSON** | Parse `body.content[0].text` | Anthropic renvoie du texte ; il faut le parser pour extraire `titre`/`paroles` |
| 6 | **Airtable › Create a Record** | Table **Generations** | `project` \= **\[Project Record ID de l'étape 3\]** · `generation_no`\=`1` · `type`\=`preview` · `lyrics` · `song_title` · `generation_status`\=`lyrics_generated` |

### **Bloc API Anthropic (module 4\)**

* **URL** : `https://api.anthropic.com/v1/messages`  
* **Method** : POST  
* **Headers** :  
  * `x-api-key` : clé Anthropic (connexion/variable Make, **jamais en dur**)  
  * `anthropic-version` : `2023-06-01`  
  * `content-type` : `application/json`  
* **Body (raw JSON)** :

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 2000,
  "system": "PROMPT VOIX DE MARQUE CM — solution-first, identité québécoise, jamais ouvrir sur le deuil. Structure couplet/refrain. Réponds UNIQUEMENT en JSON valide: {\"titre\":\"...\",\"paroles\":\"...\"} sans aucun texte avant ou après.",
  "messages": [
    { "role": "user", "content": "Personne: {{prenom_defunt}}. Relation: {{relation}}. Style: {{style_musical}}. Voix: {{voix}}. Ambiance: {{ambiance}}. Ce qui la rendait unique: {{unicite}}. Souvenirs: {{souvenirs}}. À garder: {{souvenir_garder}}." }
  ]
}
```

* **Piège** : force le JSON pur dans le system prompt, sinon le modèle ajoute « Voici les paroles : » et le Parse JSON plante.

---

## **MAKE B — Confirmation / régénération des PAROLES (non plafonnée)**

Déclenché par `revision.html` (POST avec `token`, `modifications`, `sans_modification`).
**Les paroles ne sont PAS plafonnées.** Le plafond (5) porte sur la **chanson** (voir MAKE C-gen).

* **Branche A — confirmé** (`sans_modification=true`) : → déclenche **MAKE C-gen** (génération AUDIO Suno sur les `lyrics` de la dernière Generation).
* **Branche B — modifications** (`modifications` non vide) : → nouvelle Generation (`type`\=`lyrics_regeneration`, `generation_no`\+1, `requested_changes`\=modifs) \+ régénère les paroles via Anthropic → **retour à `revision`** pour ré-approbation. Pas de filtre/limite.

> Note : la régénération **paroles** vit déjà dans `revision.html` (appel Anthropic direct) et fonctionne — on ne la reconstruit pas. La régénération **chanson** (plafonnée) se déclenche depuis le **preview** en repassant par le formulaire pré-rempli (`lire-survey.js`), pas depuis `revision`.

---

## **MAKE C-gen — Lancement de la CHANSON (Suno generate, plafond 5)**

Déclenché par : (a) approbation des paroles (MAKE B branche A), ou (b) régénération chanson depuis le preview, ou (c) post-achat (régén chanson / cover).

| \# | Module | Action | Note |
| ----- | ----- | ----- | ----- |
| 1 | **Filter** | `song_regenerations_count < 5` (pré-achat) **ou** `post_purchase_regenerations_count < 5` (post-achat) | Sinon → message « plafond atteint » + incitation achat ; pas d'appel Suno |
| 2 | *(post-livraison only)* **HTTP Anthropic — décortique** | route les demandes libres (prononciation/paroles/style) → `{prompt, style}` ajustés (édition **ciblée**) | Pas de décortique à la génération initiale |
| 3 | **Data Store › Get** | clé `style_musical × ambiance` → chaîne `style` Suno | Ton mini-prompt de directives musicales |
| 4 | **HTTP › Suno generate** | `POST https://api.sunoapi.org/api/v1/generate` (voir bloc) | Renvoie `taskId` |
| 5 | **Airtable › Create Generation** | `type`\=`song`/`song_regeneration`/`cover`, `suno_task_id`\=`{{taskId}}`, `generation_status`\=`audio_pending` | `post_purchase`\=true si post-achat |

### **Bloc API Suno — generate (module 4\)**

* **URL** : `POST https://api.sunoapi.org/api/v1/generate`
* **Headers** : `Authorization: Bearer {{SUNO_API_KEY}}` (variable Make, jamais en dur), `content-type: application/json`
* **Body (raw JSON)** :

```json
{
  "customMode": true,
  "instrumental": false,
  "model": "V5_5",
  "prompt": "{{paroles_de_la_derniere_generation}}",
  "style": "{{style_du_data_store}}",
  "title": "{{song_title}}",
  "vocalGender": "{{m_ou_f_depuis_voix}}",
  "callBackUrl": "https://hook.<region>.make.com/<MAKE_C_cb_webhook>"
}
```

* ⚠ Suno renvoie **2 pistes** ; on ne garde QUE **`data.data[0]`** au callback. `prompt` = paroles exactes (`instrumental=false`). `style`/`title` requis en customMode.

### **Cover (post-achat) — variante du module 4**

* **URL** : `POST https://api.sunoapi.org/api/v1/generate/upload-cover`
* **Body** : idem + `uploadUrl` = URL Cloudinary de la piste complète existante, `prompt` = paroles ajustées. Garde la mélodie/style, change les paroles.

Réf. docs : `generate-music`, `generate-music-callbacks`, `upload-and-cover-audio`, `upload-and-cover-audio-callbacks` (docs.sunoapi.org).

---

## **MAKE C-cb — Callback Suno (async, reçoit l'audio)**

Suno est **asynchrone à callback** : `generate`/`upload-cover` renvoient un `taskId`, puis Suno rappelle ton `callBackUrl` quand c'est prêt. → **scénario séparé** qui *reçoit* le callback. Le callback envoie `data.task_id` + `data.callbackType` (`text`/`first`/`complete`/`error`) + `data.data[]` (les 2 pistes).

1. **Webhook** (reçoit le callback). **Filtre `callbackType = complete`** (ignore `text`/`first`). Si `error`/`code != 200` → patron alerte (§6).
2. **Search Generation** par `suno_task_id = {{data.task_id}}` → la bonne Generation.
3. **Prend `data.data[0]`** (piste [0] uniquement) → télécharge `data.data[0].audio_url` → **upload Cloudinary** (asset **complet**).
4. **Airtable › Update Generation** : `cloudinary_audio_url` = URL Cloudinary complète, `song_id` = `data.data[0].id`, `generation_status` = `audio_generated`.

> **Preview 60s** : pas de 2e fichier. Le preview est servi par une **transformation Cloudinary** (offset de durée à 60s) appliquée à `cloudinary_audio_url`. `lire-projet.js` renvoie la version tronquée tant que `commercial_status != purchased` ; la complète est gatée serveur.
>
> **2 identifiants** : `suno_task_id` (= `data.task_id`, matche le callback) ≠ `song_id` (= `data.data[0].id`, la piste).

---

## **MAKE D — Webhook Stripe (la chaîne argent)**

1. Webhook Stripe (événement `checkout.session.completed`)  
2. Airtable › Update Project : `commercial_status`\=`purchased`, `purchase_date`\=`now()`, `amount`, `stripe_session_id`, `stripe_payment_intent`  
3. **Meta CAPI** : event `Purchase` côté serveur, avec `fbc`/`fbp` \+ email hashé → attribution impossible à bloquer par adblock  
4. Courriel de livraison (lien `/page-chanson?id=TOKEN` ou `/page-memoire?id=TOKEN`)

**Anti double-traitement** : vérifier que `stripe_payment_intent` n'est pas déjà écrit avant de traiter (Stripe peut envoyer 2 fois le webhook).

---

## **Les 6 jonctions à tester (ordre \= irréversible d'abord)**

1. **Survey → Airtable.** Soumets un faux survey : la fiche Project apparaît-elle avec TOUT (champs \+ token \+ attribution \+ cgv\_acceptees\_at) ? Si ça casse, rien d'autre ne marche.  
2. **Token → bonne page, bon domaine.** Le lien généré pointe-t-il sur **chansonmemoire.ca** et `?id=TOKEN` correct ?  
3. **/revision lit les paroles par token.** Ouvre `/revision?id=TOKEN` : les vraies paroles de CE token s'affichent (polling → `lyrics_generated`) ?  
4. **Stripe → paid.** Vrai paiement 1 $ : Project passe à `purchased`, CAPI fire avec fbc/fbp, livraison débloquée ?  
5. **Fallback courriel 15 min.** Onglet fermé après confirmation : le courriel part-il avec le lien **sur .ca** et le bon token ?  
6. **Compteur de CHANSON, côté serveur.** 6e régénération **chanson** bloquée par le filtre Make (`song_regenerations_count` pré-achat / `post_purchase_regenerations_count` post-achat) ? (Les **paroles** ne sont pas plafonnées.)
7. **Pré-remplissage survey.** `/souvenirs?id=TOKEN` → `lire-survey.js` renvoie-t-il les réponses précédentes (champs minimisés) pour la régén chanson ?
8. **Preuve de livraison.** Gate « Recevoir ma chanson » → signature → `accepter-livraison.js` écrit-il la preuve (signature + horodatages) sur le Project avant de révéler la page ?

**Test isolé recommandé AVANT Make** : crée à la main un Project (token=`test-123`) \+ une Generation `lyrics_generated`, va sur `/revision?id=test-123`. Si les paroles s'affichent, toute la chaîne lecture (fonction \+ toml \+ variables \+ noms de champs) est bonne indépendamment de Make.

---

## **Sécurité (non négociable)**

* **Token \= UUID v4** (122 bits, non devinable). Jamais le record ID Airtable dans l'URL.  
* **`lire-projet.js` renvoie filtré** : titre, paroles, statut, audio, suggestions, commercial\_status. **JAMAIS** email, stripe\_\*, attribution. Décidé champ par champ côté serveur.  
* **`lire-survey.js` (fonction séparée, lecture seule)** : renvoie UNIQUEMENT les champs du formulaire pour le pré-remplissage (`prenom_defunt, relation, style_musical, ambiance, voix, unicite, souvenirs, souvenir_garder`). Jamais email/stripe/attribution/consentement. Même sécurité (UUID + 404 nu).  
* **Téléchargement / preuve** : `accepter-livraison.js` (signature + horodatages → Project) et `telecharger.js` (gate `commercial_status=purchased` + log `downloaded_at`) — fonctions serveur, jamais d'URL Cloudinary complète exposée avant paiement.  
* **404 nu** sur introuvable — ne jamais révéler « existe mais pas payé » (aide au sondage).  
* **PAT Airtable scopé serré** : scopes `data.records:read` \+ `data.records:write`, accès à la **base CM uniquement**. Si fuite → ne touche que CM.  
* **Secrets en variables d'env Netlify** (`AIRTABLE_TOKEN`, `AIRTABLE_BASE_ID`), jamais dans le HTML/JS client. Clé Anthropic et Suno : même règle, côté serveur seulement.  
* **Polling borné** : 5 sec d'intervalle, arrêt à l'état terminal attendu (`lyrics_generated` sur `/revision` ; `audio_generated` sur `/attente`), plafond 2 min. Pas de ping infini. Page finale \= lecture unique, zéro polling.  
* **Rate limit Airtable (5 req/sec/base)** : géré naturellement par l'intervalle de 5 sec. Rien à implémenter à ce volume.

---

## **Loi 25 & conformité légale (drapeaux systématiques)**

* **`cgv_acceptees_at`** horodaté par Make (`now()` serveur), pas le client. Sans ça, aucune preuve de consentement.  
* **`consent_status` \= withdrawn** → arrêter tout courriel à ce client. Prévoir le mécanisme de retrait.  
* **Divulgation IA au point d'achat** : à maintenir dans le copy du funnel (aperçu/checkout). Ne pas retirer.  
* **CAPI \= transfert de données client à Meta** (email hashé, fbc/fbp) → doit être couvert par la politique de confidentialité et le consentement. À valider avant de brancher.  
* **Loi sur la concurrence** : tout prix de référence / prix barré sur l'aperçu doit être substantié. Order bumps (PDF, instrumental) : prix validés **côté serveur**.  
* **Protection du consommateur** : **aucun témoignage / avis / résultat fabriqué.** (Historique de violations corrigées.)  
* ⚠️ Tout livrable légal \= **point de départ à faire valider**, jamais un avis juridique.

---

## **Ce que tu allais oublier (checklist)**

1. **`cgv_acceptees_at` n'est écrit nulle part** tant que tu ne l'ajoutes pas au Create Project (module A-3). Loi 25\.  
2. **Bug domaine (vu dans le chat pixel)** : `canonical` / `og:url` pointaient sur `netlify.app`, et les liens légaux \+ courriel Brigitte sur `.com`. **Doit être `.ca` partout.** À corriger.  
3. **Témoignages** : 5 avis avec noms \+ villes — substantiés et consentis, ou retirés avant trafic payant.  
4. **Le `fbp` ne se reconstruit pas** côté serveur. S'il n'est pas capté au navigateur (maintenant fait dans le survey corrigé), ton CAPI perd en match quality.  
5. **Suno \= scénario séparé** (callback async). Ne pas l'empiler dans Make A.  
6. **Upload Cloudinary** \= une étape Make à ne pas oublier entre Suno et l'affichage (sinon tu sers une URL Suno temporaire).  
7. **Doublon `payment_intent` vs `stripe_payment_intent`** dans Projects → en supprimer un.  
8. **`generation_status` orthographe exacte** : le polling Netlify attend `lyrics_generated`. Une faute \= page qui tourne dans le vide.  
9. **Confirme `cloudinary_audio_url`** au caractère près dans Generations.  
10. **Coût Make vs Netlify** : surveille ton compteur d'ops mensuel quand tu scales le Meta spend (la génération paroles dans Make consomme des ops).  
11. **Régénérations pré-paiement \= coût Suno** : `generations_count` reste visible pour détecter un abus si le profil de trafic change.  
12. **`delivery_url` manquant** sur Upsells : nulle part où stocker les livrables vendus.

