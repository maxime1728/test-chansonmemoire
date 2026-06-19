# Make — livrables production musicale (Chanson Mémoire)

Specs des scénarios Make + corps HTTP prêts à l'emploi pour la chaîne audio Suno.

> ⚠️ **Portée.** Ce sont des **specs de configuration** (modules + mappings) et des **corps HTTP
> directement utilisables**, pas des blueprints `.json` auto-importables dans Make (qui exigent les
> IDs/versions internes des modules). Les MCP Make/Airtable sont déconnectés volontairement — rien
> n'a été appliqué en live. À monter sur le **scénario sandbox dupliqué** et la **base Airtable de
> test** (jamais la prod).

## Fichiers
- `MAKE_C-gen.json` — lancement de la chanson (Suno `generate`), plafond 5.
- `MAKE_C-cb.json` — réception du callback Suno (garde la piste [0], upload Cloudinary).
- `http_bodies.json` — corps HTTP prêts : Suno `generate`, `upload-cover`, Anthropic « décortique ».
- `anthropic_decortique_prompt.md` — system prompt du décortique (post-livraison).

## Variables / connexions à préparer (jamais en dur)
- `SUNO_API_KEY` — clé sunoapi.org (header `Authorization: Bearer`).
- `ANTHROPIC_API_KEY` — header `x-api-key`.
- Connexion Airtable scopée **base de test** uniquement (`data.records:read` + `:write`).
- Connexion Cloudinary (upload).
- **Webhook `MAKE_C-cb`** : créer le webhook Make d'abord, copier son URL dans `callBackUrl`
  de `generate`/`upload-cover`.

## Modèle Suno
`V5_5`. `customMode=true`, `instrumental=false` (le `prompt` = paroles exactes).
On ne garde QUE `data.data[0]` (Suno renvoie 2 pistes). Preview 60s = transformation Cloudinary.
