# Audit de sécurité pré-lancement — Chanson Mémoire

> Revue de la **surface de livraison** (pages token + Netlify Functions), centrée sur le risque ouvert de CLAUDE.md §10 : **énumération des données clients**. Date : 2026-06-22.

## Verdict

**La surface de livraison est prête pour le lancement du point de vue de l'énumération.** Le flag §10 (« pages basées sur slug ») peut être **rétrogradé** : tout passe par un token UUID v4 inguessable, aucune route par slug. Un seul point mérite une décision (email dans l'URL, ci-dessous).

## Ce qui a été vérifié — ✅ solide

| Contrôle | État |
|---|---|
| **Token UUID v4 validé avant tout appel Airtable** (21/21 fonctions) | ✅ — bloque énumération (122 bits) + injection `filterByFormula` |
| **`{project}` (dérivé de `deceased_name`, input client) échappé** via `formulaLiteral` partout | ✅ — pas d'injection via le nom du défunt |
| **Réponses minimisées** (`lire-projet`, `lire-versions`, `telecharger`) | ✅ — jamais email / Stripe / attribution / consentement (§6) |
| **Téléchargement gaté serveur** (`telecharger` exige `purchased`) + URL Cloudinary **signée** | ✅ — URL complète jamais émise avant achat ; preview `du_60` signé non contournable |
| **Routing 100 % par token** (`?id=UUID`), aucun slug, `sessionStorage` abandonné | ✅ — pas d'identifiant énumérable |
| **Pages token = `noindex, nofollow` + `referrer: no-referrer`** | ✅ — pas d'indexation, pas de fuite via Referer |
| **Pixel Meta uniquement sur `index.html`, derrière le consentement** | ✅ — Loi 25 ; jamais sur les pages token |
| **404 nus** (« Introuvable »), aucun message qui révèle l'existence d'un projet | ✅ |
| **Secrets en env** (aucune clé en dur), CORS non-wildcard (pas de lecture cross-origin) | ✅ |
| **CAPI token-safe** : on n'envoie jamais le token brut à Meta (haché) | ✅ |

## Constats & recommandations

### 🟡 1. Email accepté dans l'URL (`apercu.html`) — minimisation Loi 25
`apercu.html` lit `?email=` et `?name=` dans l'URL (préremplir Stripe + personnaliser « Aperçu pour X »). Le `no-referrer` empêche la fuite vers des tiers (pixel, Stripe, Cloudinary), mais **un email dans l'URL persiste dans l'historique du navigateur et les logs d'accès Netlify**.

**Recommandation** : retirer `?email=` du lien vers `/apercu` (Stripe collecte l'email au checkout de toute façon → coût UX nul). Garder `?name=` est acceptable (prénom seul, sensibilité faible, couvert par `no-referrer`) — ou le déplacer côté serveur si on veut zéro PII en URL. **Décision Maxime** : dépend de qui génère ce lien (courriel de livraison / Make / GHL).

### 🟢 2. Pas de limitation de débit applicative (défense en profondeur)
Le brute-force de token est déjà infaisable (UUID v4 = 122 bits). Optionnel : activer une **règle de rate limiting Netlify** sur `/api/*` comme filet (abus/coût), sans criticité sécurité.

### 🟢 3. `Cache-Control` sur les endpoints de lecture (défense en profondeur)
`lire-projet` / `lire-versions` / `telecharger` renvoient des URLs signées. Ajouter `Cache-Control: no-store` éviterait toute mise en cache par un intermédiaire. Risque actuel faible (pas de CDN devant `/api/*`).

### ℹ️ 4. Périmètre du token Airtable (ops, hors code)
S'assurer que le `AIRTABLE_TOKEN` utilisé par les fonctions est **au moindre privilège** (accès à la seule base CM, scopes nécessaires). À confirmer côté Netlify/Airtable.

## Hors périmètre de cet audit (rappels)
- Validation **juridique** (CGV, Loi 25, prix/taxes, divulgation IA) = à faire valider par un pro (bloquant lancement) — ce n'est pas un audit technique.
- Permanence des fichiers add-ons (Cloudinary re-host) = traitée séparément (PR `feat/rehost-cloudinary`), enjeu de disponibilité, pas de sécurité.

## Conclusion
Aucune vulnérabilité d'énumération ou d'injection trouvée sur la surface de livraison. Le **constat 🟡 #1 (email en URL)** est le seul à actionner avant le lancement ; les autres sont de la défense en profondeur optionnelle.
