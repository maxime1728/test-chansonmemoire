-- =============================================================================
-- Chanson Mémoire / Chanson Pour Toujours — Schéma Postgres équivalent (Supabase)
-- Maquette d'évaluation. Traduit le modèle Airtable actuel en vrai relationnel.
-- Objectif : montrer concrètement ce que Postgres règle (contraintes, jointures,
-- comptages fiables, zéro dérive de schéma). NON destiné à être exécuté tel quel :
-- à raffiner table par table lors de la migration réelle.
-- =============================================================================

-- Types énumérés = fini les "single select" qui cassent en silence à la moindre faute.
create type commercial_status  as enum ('preview_only', 'purchased', 'refunded');
create type consent_status     as enum ('received', 'withdrawn');
create type generation_type    as enum ('lyrics', 'lyrics_regeneration', 'song', 'song_regeneration', 'cover');
create type generation_status  as enum ('lyrics_generated', 'audio_pending', 'audio_generated', 'validated');
create type upsell_type        as enum ('video', 'lyrics_pdf', 'instrumental', 'plaque_indoor', 'plaque_outdoor', 'paroles_vivantes');
create type upsell_status      as enum ('purchased', 'delivered', 'refunded');

-- =============================================================================
-- CLIENTS  (unicité par email = vraie contrainte, plus un "upsert" bricolé)
-- =============================================================================
create table clients (
  id                  uuid primary key default gen_random_uuid(),
  email               citext unique not null,          -- citext = insensible à la casse, unicité garantie
  contact_name        text,
  first_contact_date  timestamptz not null default now(),
  last_activity_date  timestamptz,
  consent_status      consent_status not null default 'received',
  consent_date        timestamptz,
  created_at          timestamptz not null default now()
);

-- =============================================================================
-- PROJECTS  (1 token = 1 project = 1 personne décédée)
-- =============================================================================
create table projects (
  id                      uuid primary key default gen_random_uuid(),
  token                   uuid unique not null default gen_random_uuid(),  -- la clé de tout le parcours
  client_id               uuid not null references clients(id) on delete restrict,
  deceased_name           text not null,
  relationship            text,
  music_style             text,
  voice                   text,
  mood                    text,
  occasion                text default 'memorial',
  what_made_unique        text,
  memories                text,
  memory_to_keep          text,
  language                text not null default 'fr-CA',
  commercial_status       commercial_status not null default 'preview_only',
  amount                  numeric(10,2),
  purchase_date           timestamptz,
  -- Preuve de consentement / livraison (Loi 25). Contrainte : jamais un timestamp client.
  cgv_acceptees_at        timestamptz,
  recevoir_clicked_at     timestamptz,
  delivery_signature_name text,
  delivery_signature_at   timestamptz,
  delivery_accessed_at    timestamptz,
  acceptance_ip           inet,
  acceptance_user_agent   text,
  downloaded_at           timestamptz,
  download_count          int not null default 0,
  -- Stripe (un seul champ payment_intent, plus de doublon)
  stripe_session_id       text,
  stripe_payment_intent   text unique,     -- unique = anti double-traitement natif
  -- Attribution (remplace les colonnes utm_* + fbclid éparpillées ; jsonb = souple)
  attribution             jsonb not null default '{}'::jsonb,
  created_at              timestamptz not null default now()
);
create index on projects (client_id);
create index on projects (commercial_status);
create index on projects using gin (attribution);

-- =============================================================================
-- GENERATIONS  (chaque appel Suno / paroles = une ligne)
-- =============================================================================
create table generations (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references projects(id) on delete cascade,
  generation_no         int not null,
  type                  generation_type not null,
  post_purchase         boolean not null default false,
  suno_task_id          text,
  song_id               text,
  lyrics                text,
  song_title            text,
  requested_changes     text,
  status                generation_status not null default 'lyrics_generated',
  cloudinary_audio_url  text,
  created_at            timestamptz not null default now(),
  unique (project_id, generation_no)      -- pas deux fois le même numéro pour un projet
);
create index on generations (project_id, generation_no desc);   -- "la plus récente" = 1 requête
create index on generations (suno_task_id);                     -- match callback = O(log n), pas un scan

-- =============================================================================
-- PLAFONDS = ce qui était des "rollups filtrés" fragiles dans Airtable.
-- Ici : des VUES calculées à la volée, toujours justes, zéro cron de recomptage.
-- =============================================================================
create view project_counts as
select
  p.id as project_id,
  count(g.*) filter (where g.suno_task_id is not null and not g.post_purchase
                       and g.type in ('song','song_regeneration','cover')) as song_regens_pre,
  count(g.*) filter (where g.suno_task_id is not null and g.post_purchase
                       and g.type in ('song','song_regeneration','cover')) as song_regens_post
from projects p
left join generations g on g.project_id = p.id
group by p.id;
-- Vérif de plafond à l'envoi : SELECT song_regens_pre FROM project_counts WHERE project_id = $1  ->  < 6 ?

-- =============================================================================
-- UPSELLS  (add-ons payants)
-- =============================================================================
create table upsells (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references projects(id) on delete cascade,
  type           upsell_type not null,
  price          numeric(10,2),
  status         upsell_status not null default 'purchased',
  purchase_date  timestamptz not null default now(),
  delivery_url   text,
  created_at     timestamptz not null default now()
);
create index on upsells (project_id);

-- =============================================================================
-- TRACKING PUBS  (Pubs + Pubs_Performance)
-- Le cas où Airtable fait le plus mal : write-heavy + doublons (pas de contrainte).
-- =============================================================================
create table pubs (
  id            uuid primary key default gen_random_uuid(),
  meta_ad_id    text unique not null,       -- LA contrainte qui tue tes doublons
  nom           text,
  campagne      text,
  ensemble      text,
  hook_rate     numeric,
  created_at    timestamptz not null default now()
);

create table pubs_performance (
  id            uuid primary key default gen_random_uuid(),
  pub_id        uuid not null references pubs(id) on delete cascade,
  jour          date not null,
  depense       numeric(10,2),
  impressions   bigint,
  clics         bigint,
  ctr           numeric,
  roas          numeric,
  unique (pub_id, jour)                     -- 1 ligne par pub par jour, upsert propre
);
create index on pubs_performance (jour);

-- =============================================================================
-- CONVERSATIONS / COURRIELS  (support + corrections)
-- =============================================================================
create table conversations (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid references projects(id) on delete set null,
  client_id     uuid references clients(id) on delete set null,
  direction     text,          -- 'entrant' / 'sortant'
  sujet         text,
  corps         text,
  statut        text,
  created_at    timestamptz not null default now()
);
create index on conversations (project_id);
create index on conversations (client_id);

-- =============================================================================
-- NOTE Row Level Security (RLS) :
-- En prod Supabase, activer RLS sur chaque table et n'exposer QUE via la clé
-- service côté fonctions Netlify (jamais la clé anon au navigateur pour ces tables).
-- Le token du projet reste la clé d'accès applicative, jamais l'id interne.
-- =============================================================================
