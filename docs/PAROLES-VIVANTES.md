# Paroles vivantes — vidéo (add-on)

Vidéo souvenir où les **paroles apparaissent en fondu, ligne par ligne**, calées sur la voix, par-dessus la chanson achetée. Add-on post-achat (13,99 $) sur la page mémoire.

Rendu par **Shotstack** (API JSON → MP4). Aucune nouvelle infra : une fonction Netlify construit l'« edit » et lance le rendu, exactement comme l'instrumentale.

## Pièces

| Fichier | Rôle |
|---|---|
| `netlify/functions/_lib/paroles-vivantes-timeline.js` | **Design** (palette, polices, timing). Source unique partagée prod ↔ test. |
| `netlify/functions/lancer-paroles-vivantes.js` | Gate `purchased` + idempotent → paroles horodatées Suno → edit → lance le rendu Shotstack. |
| `netlify/functions/callback-paroles-vivantes.js` | Webhook Shotstack → écrit `video_url` sur le Project (matché par `video_task_id`). |
| `tools/rendu-test.js` | Rendu de **test gratuit** (sandbox), même design que la prod. |
| `lire-projet.js` / `page-memoire.html` | Exposent `video_url` ; bouton « Télécharger » quand la vidéo est livrée. |

Champs Airtable (Projects) créés : `video_task_id`, `video_url`.

## Synchronisation

On lit les **paroles horodatées** de Suno (`POST /api/v1/generate/get-timestamped-lyrics`, `{taskId, audioId}` → `alignedWords[]` avec `startS`/`endS`) pour caler chaque ligne sur la voix. Si l'alignement manque, repli automatique sur une cadence douce et fixe (le rendu reste correct).

## Voir un rendu GRATUIT (avant tout abonnement)

1. Crée un compte Shotstack → **Sandbox** → copie la **Sandbox API Key** (gratuit, sortie en filigrane).
2. Dans le repo :
   ```powershell
   $env:SHOTSTACK_API_KEY="ta_cle_sandbox"
   node tools/rendu-test.js
   ```
   Le script imprime l'URL du MP4 (paroles + audio d'exemple intégrés — aucune donnée réelle requise).
3. Variante zéro-code : colle l'edit dans le **API Sandbox** du dashboard Shotstack.

> Le test n'a pas d'horodatage Suno → il montre le **style** (cadence douce). En prod, les lignes sont **synchronisées** sur la voix.

## Variables d'environnement (Netlify)

| Variable | Valeur | Note |
|---|---|---|
| `SHOTSTACK_API_KEY` | clé Shotstack | **sandbox** pour tester, **production** pour le live |
| `SHOTSTACK_ENV` | `stage` \| `v1` | `stage` = sandbox (défaut). **Passer à `v1` au live.** |
| `SHOTSTACK_RESOLUTION` | `hd` | défaut `hd` ; `sd` pour plus rapide |
| `SUNO_API_KEY` | (déjà là) | paroles horodatées |
| `CLOUDINARY_API_SECRET` | (déjà là) | URL audio complète signée |
| `STRIPE_PRICE_PAROLES_VIVANTES` | `price_…` | prix de l'add-on (créer-upsell) |

## Câblage Make (MAKE D) — déclencher la vidéo après paiement

Dans la branche upsell de MAKE D, **après** l'enregistrement de l'achat, ajouter un module **HTTP** :
- **Condition** : `metadata.upsell_type` = `paroles_vivantes`
- **POST** `https://chansonmemoire.ca/api/lancer-paroles-vivantes`
- **Body JSON** : `{ "token": "{{2.data.client_reference_id}}" }`

(Même patron que l'instrumentale, qui poste vers `/api/lancer-instrumentale`.)

## À durcir avant le live 🔴

- **Permanence des URLs** : `callback-paroles-vivantes` stocke l'URL de sortie Shotstack telle quelle. Comme pour l'instrumentale, **ré-héberger sur Cloudinary** (les URLs Shotstack ne sont pas permanentes). Marqué `⚠️` dans le callback.
- **Photo du défunt** (optionnel, non inclus en v1) : on peut ajouter une photo en arrière-plan. ⚠️ Vérifier d'abord que le **consentement Loi 25** à l'intake couvre cet usage avant de l'activer.
- `SHOTSTACK_ENV=v1` + clé production.
