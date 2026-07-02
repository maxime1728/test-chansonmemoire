# RLS : portée RÉELLE (à lire avant de se sentir en sécurité)

> Exigence du plan v2 (§2 point 3 et §4) : documenter noir sur blanc ce que RLS
> protège et ne protège PAS dans notre architecture.

## La phrase à retenir

**La sécurité runtime du .ca, c'est le CODE des fonctions Netlify, pas RLS.**

## Pourquoi

Les fonctions Netlify se connectent à Postgres via la connection string du pooler
(rôle propriétaire des tables) et, si un jour on utilise l'API Supabase, via la clé
`service_role`. Ces deux chemins **BYPASSENT Row Level Security**. C'est le
fonctionnement normal de Supabase : RLS filtre les rôles `anon` et `authenticated`
(la surface PostgREST / clé publique), pas le backend privilégié.

Conséquences concrètes :

- Une faille de logique dans une fonction (ex. oublier de vérifier le token avant de
  renvoyer un projet) N'EST PAS rattrapée par RLS. La parade reste : validation du
  token UUID en entrée, réponses filtrées, tests, revue de PR (cf. SECURITY-AUDIT.md).
- RLS nous protège d'UN scénario précis : quelqu'un qui découvre l'URL PostgREST du
  projet et la clé `anon` (elle est publique par design chez Supabase). Avec RLS
  activé partout + zéro policy permissive + REVOKE sur `anon`/`authenticated`
  (migration 0002), cette surface renvoie **zéro donnée**.

## Ce qui est en place (migration 0002_garde_fous.sql)

1. `ENABLE ROW LEVEL SECURITY` sur les 14 tables. Aucune policy permissive : RLS sans
   policy = tout est refusé pour les rôles soumis à RLS.
2. `REVOKE ALL` + `ALTER DEFAULT PRIVILEGES` sur `anon` et `authenticated` : même si
   une policy permissive apparaissait par erreur, ces rôles n'ont aucun privilège table.
3. Vues `*_actifs` en `security_invoker = true` : aucune escalade de privilège par vue.

## Recommandations d'exploitation (dashboard Supabase, non bloquant)

- **Désactiver l'API Data (PostgREST)** dans Settings → API tant qu'aucun client ne
  l'utilise : surface fermée = surface qu'on n'audite pas. On la rouvrira si le
  cockpit Phase 2 l'exige (avec Supabase Auth + policies par rôle, Nathalie ≤3 mois).
- Ne JAMAIS mettre la clé `service_role` ailleurs que dans les env Netlify.
- Phase 2 (Auth + rôles ops/admin) : les policies par rôle seront écrites AVANT
  d'exposer quoi que ce soit à `authenticated`, et testées.

## Évolution prévue

| Phase | État RLS |
|---|---|
| 1 (maintenant) | RLS partout, zéro policy, PostgREST fermé de facto |
| 2 (cockpit + Auth) | policies par rôle (ops/admin) écrites et testées AVANT exposition |
| 3+ | rôle applicatif à privilèges réduits pour les fonctions (défense en profondeur supplémentaire, optionnel) |
