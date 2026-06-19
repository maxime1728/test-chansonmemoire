# **CM — Mapping Airtable (source de vérité unique)**

**Pourquoi ce fichier existe :** Make ET les fonctions Netlify lisent/écrivent dans cette base. Si un nom de champ dérive à un seul endroit, ça casse en silence. Ce document est LA référence. Avant de mapper quoi que ce soit dans Make ou de coder une fonction Netlify, on s'aligne ici.

**Légende statut :**

* ✅ **CONFIRMÉ** — existe dans la base, vérifié.  
* ➕ **À AJOUTER** — recommandé, pas encore créé (launch-blocker ou quasi).  
* ⚠️ **À TRANCHER** — décision en attente, voir note.

---

## **Règle d'or de routage**

* **`token` (UUID v4) \= la clé d'accès de TOUT le parcours.** Généré dans le survey, voyage dans l'URL (`?id=TOKEN`), écrit sur le **Project**.  
* **1 token \= 1 Project \= 1 personne décédée.** Ne change jamais, peu importe le nombre de régénérations.  
* **Le record ID Airtable reste INTERNE au serveur.** Jamais dans l'URL, jamais renvoyé au navigateur.  
* **Client \= Upsert** (par email, fiche réutilisée). **Project \= Create** (toujours neuf).

---

## **TABLE 1 — Clients**

| Champ | Type | Statut | Écrit par | Note |
| ----- | ----- | ----- | ----- | ----- |
| `email` | Primary · Email | ✅ | Make (Upsert, clé de recherche) | Clé d'unicité du client |
| `contact_name` | Single line text | ✅ | Make |  |
| `first_contact_date` | Date | ✅ | Make (au 1er upsert) | Ne pas écraser si client existe |
| `last_activity_date` | Date | ✅ | Make | MAJ à chaque nouvelle activité |
| `consent_status` | Single select : received / withdrawn | ✅ | Make / Support | Loi 25 — si `withdrawn`, **stopper tout courriel** |
| `consent_date` | Date | ✅ | Make | Premier consentement marketing |
| `projects` | Link → Projects | ✅ | Make (auto via lien) |  |
| `total_projects` | Rollup (count) sur projects | ✅ | Auto |  |
| `total_generations_client` | Rollup (sum) sur projects → generations\_count | ✅ | Auto |  |

---

## **TABLE 2 — Projects**

| Champ | Type | Statut | Écrit par | Lu par | Note |
| ----- | ----- | ----- | ----- | ----- | ----- |
| `project` | Primary · Formula | ✅ | Auto | — | `{deceased_name} & " – " & DATETIME_FORMAT({created_date},'YYYY-MM-DD')` |
| **`token`** | Single line text | ➕ **LAUNCH-BLOCKER** | Survey → Make écrit la valeur reçue | Netlify (filterByFormula) | UUID v4. La clé de tout. |
| `client` | Link → Clients | ✅ | Make (**Record ID** de l'Upsert, jamais l'email) | — | Tableau de record IDs |
| ~~`task_id`~~ | Single line text | ⚠️ **À RETIRER de Projects** | — | — | **Tranché** : le task ID Suno vit sur **Generations** (`suno_task_id`), pas ici. Retirer de Projects. |
| `deceased_name` | Single line text | ✅ | Make ← survey `prenom_defunt` | Netlify |  |
| `relationship` | Single select | ✅ | Make ← survey `relation` |  | Valeurs \= options du survey |
| `music_style` | Single select | ✅ | Make ← survey `style_musical` |  |  |
| `voice` | Single select | ✅ | Make ← survey `voix` |  | Masculine / Féminine |
| `mood` | Single select | ✅ | Make ← survey `ambiance` |  |  |
| `occasion` | Single select : memorial / gift | ✅ | Make (**fixe \= `memorial`** pour l'instant) |  | Survey ne capte pas encore. À revisiter. |
| `what_made_unique` | Long text | ✅ | Make ← survey `unicite` |  |  |
| `memories` | Long text | ✅ | Make ← survey `souvenirs` |  |  |
| `memory_to_keep` | Long text | ✅ | Make ← survey `souvenir_garder` |  |  |
| `commercial_status` | Single select : preview\_only / purchased / refunded | ✅ | Make (`preview_only` à la création, `purchased` au webhook Stripe) | Netlify | Décide ce que les pages affichent |
| `created_date` | Created time | ✅ | Auto |  |  |
| `purchase_date` | Date | ✅ | Make (webhook Stripe) |  | Vide jusqu'à l'achat |
| `amount` | Currency | ✅ | Make (webhook Stripe) |  | Vide jusqu'à l'achat |
| **`cgv_acceptees_at`** | Date/heure | ➕ **Loi 25** | Make \= `now()` à la création (**jamais** un timestamp client) |  | Preuve de consentement CGV. Obligatoire. |
| `generations` | Link → Generations | ✅ | Auto via lien |  |  |
| `generations_count` | Rollup (count) sur generations | ✅ | Auto |  | Compte TOUT (preview \+ regen) — indicateur, pas un blocage |
| `previews_count` | Rollup (count) filtré type=preview | ✅ | Auto |  |  |
| **`song_regenerations_count`** | Rollup (count) sur generations, filtre `suno_task_id` non vide **ET** `post_purchase`=décoché | ➕ (rollup = manuel UI) | Auto | Make (filtre limite) | Compte les chansons générées pré-achat (chaque appel Suno a un `suno_task_id`). Plafond : 1re + 5 régén → `< 6`. Paroles NON plafonnées. |
| **`post_purchase_regenerations_count`** | Rollup (count) sur generations, filtre `suno_task_id` non vide **ET** `post_purchase`=coché | ➕ (rollup = manuel UI) | Auto | Make (filtre limite 5\) | Régén chanson + cover post-achat (les deux ont un `suno_task_id`). Plafond `< 5`. |
| `upsells` | Link → Upsells | ✅ | Auto via lien |  |  |
| `utm_source` | Single line text | ✅ | Make ← survey |  | Attribution |
| `utm_medium` | Single line text | ✅ | Make ← survey |  |  |
| `utm_campaign` | Single line text | ✅ | Make ← survey |  |  |
| `utm_content` | Single line text | ✅ | Make ← survey |  |  |
| `utm_term` | Single line text | ✅ | Make ← survey |  |  |
| `fbclid` | Single line text | ✅ | Make ← survey |  |  |
| **`fbc`** | Single line text | ✅ (ajouté) | Make ← survey | Make (CAPI) | Cookie `_fbc`. Match quality Meta. |
| **`fbp`** | Single line text | ✅ (ajouté) | Make ← survey | Make (CAPI) | Cookie `_fbp`. **Ne se reconstruit pas** côté serveur. |
| `landing_page` | Single line text | ✅ | Make ← survey |  |  |
| **`stripe_session_id`** | Single line text | ✅ (ajouté) | Make (webhook Stripe) |  |  |
| \~\~`payment_intent`\~\~ | Single line text | ⚠️ **À SUPPRIMER** | — | — | Doublon de `stripe_payment_intent`. En garder un seul. |
| **`stripe_payment_intent`** | Single line text | ✅ (ajouté) | Make (webhook Stripe) |  | Le champ à garder. Anti double-traitement \+ remboursement. |
| **`recevoir_clicked_at`** | Date/heure | ➕ | `accepter-livraison.js` | — | Clic « Recevoir ma chanson » (intention). |
| **`delivery_signature_name`** | Single line text | ➕ | `accepter-livraison.js` | — | Signature électronique (nom saisi/tracé). Preuve d'acceptation. |
| **`delivery_signature_at`** | Date/heure | ➕ | `accepter-livraison.js` | — | Horodatage signature. |
| **`delivery_accessed_at`** | Date/heure | ➕ | `accepter-livraison.js` | — | Page révélée = preuve de réception. |
| **`delivery_acceptance_text_version`** | Single line text | ➕ | `accepter-livraison.js` | — | Version du texte d'acceptation accepté (traçabilité). |
| **`acceptance_ip`** | Single line text | ➕ | `accepter-livraison.js` | — | Loi 25 : donnée perso (preuve). Rétention + divulgation. |
| **`acceptance_user_agent`** | Single line text | ➕ | `accepter-livraison.js` | — | Métadonnée de preuve. |
| `downloaded_at` | Date/heure | ➕ (bonus) | `telecharger.js` | — | 1er téléchargement. Le verrou reste la signature, pas le download. |
| `download_count` | Number | ➕ (bonus) | `telecharger.js` | — | Incrémenté à chaque téléchargement. |

> ⚠️ **Légal (BLOQUANT)** : la portée juridique de la signature/téléchargement (remboursement / droit de résolution LPC Québec) est un **point de départ à faire valider**, jamais un avis. Le schéma ne fait que **capturer la preuve**.

---

## **TABLE 3 — Generations**

| Champ | Type | Statut | Écrit par | Lu par | Note |
| ----- | ----- | ----- | ----- | ----- | ----- |
| `generation` | Primary · Formula | ✅ | Auto |  | `{project} & " – g" & {generation_no}` |
| `project` | Link → Projects | ✅ | Make (Record ID du Project) | Netlify | Tableau de record IDs |
| `generation_no` | Number | ✅ | Make (1, 2, 3…) | Netlify (tri desc) | Sert à trouver la PLUS récente |
| `type` | Single select : lyrics / lyrics\_regeneration / song / song\_regeneration / cover | ✅ | Make |  | Distingue **paroles** vs **chanson**. Le plafond compte `song_regeneration` + `cover`. |
| **`post_purchase`** | Checkbox | ➕ | Make (true si créée après achat) | — | Sépare les compteurs pré/post-achat (voir Projects). |
| **`suno_task_id`** | Single line text | ➕ | Make (au lancement Suno) | Make (match callback) | `data.task_id` du callback. **Matche** le callback à CETTE Generation. |
| **`song_id`** | Single line text | ➕ | Make (callback) | — | `data.data[0].id` = la piste [0] gardée. ≠ `suno_task_id`. |
| `lyrics` | Long text | ✅ | Make (après API Anthropic) | Netlify |  |
| `song_title` | Single line text | ✅ | Make (après API Anthropic) | Netlify |  |
| `requested_changes` | Long text | ✅ | Make ← revision `modifications` |  | Pour les regenerations |
| `generation_status` | Single select : lyrics\_generated / audio\_pending / audio\_generated / validated | ✅ | Make | Netlify (polling) | **Orthographe EXACTE critique** — le polling attend ces valeurs. `audio_pending` = Suno lancé, callback pas encore reçu. |
| \~\~`suno_audio_url`\~\~ | URL | ⚠️ | Make (callback Suno) | — | Source brute Suno, **temporaire**. NE PAS exposer au navigateur. Garder pour debug ou supprimer. |
| **`cloudinary_audio_url`** | URL | ➕ / à confirmer le nom exact | Make (après upload Cloudinary) | Netlify | **Ce que le client écoute** (permanent). C'est ce que `lire-projet.js` renvoie. |
| \~\~`preview_slug`\~\~ | Single line text | ⚠️ **À TRANCHER** | — | — | Redondant avec `token` (routage par token). Recommandation : retirer ou laisser vide. |
| \~\~`full_slug`\~\~ | Single line text | ⚠️ **À TRANCHER** | — | — | Idem. La distinction preview/payé se fait via `commercial_status`, pas via une 2e URL. |
| `created_date` | Created time | ✅ | Auto |  |  |

---

## **TABLE 4 — Upsells**

| Champ | Type | Statut | Écrit par | Note |
| ----- | ----- | ----- | ----- | ----- |
| `upsell` | Primary · Formula | ✅ | Auto |  |
| `project` | Link → Projects | ✅ | Make | Tableau de record IDs |
| `type` | Single select : video / lyrics\_pdf / instrumental / plaque\_indoor / plaque\_outdoor | ✅ | Make |  |
| `price` | Currency | ✅ | Make |  |
| `status` | Single select : purchased / delivered / refunded | ✅ | Make |  |
| `purchase_date` | Date | ✅ | Make |  |
| **`delivery_url`** | URL | ➕ | Make (après génération du livrable) | **Manquant.** Où stocker le lien du fichier livré (instrumental, vidéo, PDF). |

---

## **Actions immédiates sur le schéma**

1. ➕ Créer `token` (Projects) — launch-blocker.  
2. ➕ Créer `cgv_acceptees_at` (Projects) — Loi 25\.  
3. ➕ Créer `song_regenerations_count` **et** `post_purchase_regenerations_count` (Projects, rollups filtrés) — plafonds 5 pré/post-achat (chanson, pas paroles).  
4. ➕ Créer/renommer `cloudinary_audio_url` (Generations) — **confirmer le nom exact au caractère près**.  
5. ➕ Créer `delivery_url` (Upsells).  
6. ⚠️ Supprimer `payment_intent` (garder `stripe_payment_intent`).  
7. ⚠️ Trancher `preview_slug` / `full_slug` (recommandation : retirer).  
8. ✅ Tranché : retirer `task_id` (Projects) ; le task ID Suno = `suno_task_id` sur Generations.  
9. ➕ Generations : `suno_task_id`, `song_id`, `post_purchase` (checkbox) ; étendre `type` (lyrics / lyrics_regeneration / song / song_regeneration / cover) ; `generation_status` += `audio_pending`.  
10. ➕ Projects : champs preuve de livraison — `recevoir_clicked_at`, `delivery_signature_name`, `delivery_signature_at`, `delivery_accessed_at`, `delivery_acceptance_text_version`, `acceptance_ip`, `acceptance_user_agent`, `downloaded_at`, `download_count`.

