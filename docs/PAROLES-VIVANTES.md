# Paroles vivantes — vidéo (add-on)

Vidéo souvenir où les **paroles apparaissent en fondu, ligne par ligne**, calées sur la voix, par-dessus la chanson achetée. Add-on post-achat (13,99 $) sur la page mémoire.

Rendu par **Creatomate** (RenderScript JSON → MP4 ; fait aussi de l'image, polyvalent). Une fonction Netlify construit le RenderScript et lance le rendu — même patron que l'instrumentale, aucune nouvelle infra.

## Pièces

| Fichier | Rôle |
|---|---|
| `netlify/functions/_lib/paroles-vivantes-timeline.js` | **Design** (palette, polices Google, timing). Source unique partagée prod ↔ test. |
| `netlify/functions/capter-timing.js` | **Capture le timing Suno à l'achat** → `Generations.lyrics_timing` (permanent). |
| `netlify/functions/lancer-paroles-vivantes.js` | Gate `purchased` + idempotent → timing (stocké→live→cadence) → RenderScript → lance le rendu Creatomate. |
| `netlify/functions/callback-paroles-vivantes.js` | Webhook Creatomate → écrit `video_url` (match par `metadata`=token, repli sur l'id). |
| `tools/rendu-test.js` | Rendu de **test** (essai gratuit), même design que la prod. |
| `lire-projet.js` / `page-memoire.html` | Exposent `video_url` ; bouton « Télécharger » quand la vidéo est livrée. |

Champs Airtable : Projects `video_task_id`, `video_url` ; Generations `lyrics_timing`.

## Timing des paroles — capture précoce (important)

Suno ne garde les données d'une génération que **~15 jours**. Comme la vidéo peut être achetée plus tard, on **capte le timing dès l'achat principal** (`capter-timing`) et on le stocke dans `lyrics_timing` (permanent).

`lancer-paroles-vivantes` lit le timing dans cet ordre : **stocké** (permanent) → **live Suno** (si < ~15 j) → **cadence douce** (repli, vidéo correcte mais non synchronisée).

> Le timing vient de la **version chantée** d'origine (`suno_task_id`/`song_id`), jamais des stems (un instrumental n'a pas de voix).

## Voir un rendu (essai gratuit)

1. Compte Creatomate → **Project Settings → API Keys** → copie une clé.
2. Dans le repo :
   ```powershell
   $env:CREATOMATE_API_KEY="ta_cle"; node tools/rendu-test.js
   ```
   Le script imprime l'URL du MP4 (paroles + audio d'exemple intégrés — aucune donnée réelle requise).

> Le test n'a pas d'horodatage Suno → il montre le **style** (cadence douce). En prod, les lignes sont **synchronisées** sur la voix.

## Variables d'environnement (Netlify)

| Variable | Valeur | Note |
|---|---|---|
| `CREATOMATE_API_KEY` | clé Creatomate | requise |
| `CREATOMATE_API_VERSION` | `v1` | défaut `v1` (`{source,…}`) ; bascule `v2` si besoin |
| `SUNO_API_KEY` | (déjà là) | paroles horodatées (capture + repli live) |
| `CLOUDINARY_API_SECRET` | (déjà là) | URL audio complète signée |
| `STRIPE_PRICE_PAROLES_VIVANTES` | `price_…` | prix de l'add-on (creer-upsell) |

## Câblage Make (MAKE D)

**Sur l'achat principal** (après l'Update `purchased`) — module **HTTP** :
- POST `https://chansonmemoire.ca/api/capter-timing`
- Body : `{ "token": "{{2.data.client_reference_id}}" }`
- *(Sauvegarde le timing tout de suite, pendant que la donnée Suno existe encore.)*

**Sur l'upsell vidéo** (après *Create Upsells*, filtre `upsell_type` = `paroles_vivantes`) — module **HTTP** :
- POST `https://chansonmemoire.ca/api/lancer-paroles-vivantes`
- Body : `{ "token": "{{2.data.client_reference_id}}" }`

## À durcir avant le live 🔴

- **Permanence des URLs** : `callback-paroles-vivantes` stocke l'URL de sortie Creatomate (~30 j). Comme pour l'instrumentale, **ré-héberger sur Cloudinary**. Marqué `⚠️` dans le callback.
- **Photo du défunt** (optionnel, non inclus en v1) : possible en arrière-plan. ⚠️ Vérifier d'abord que le **consentement Loi 25** couvre cet usage avant de l'activer.
