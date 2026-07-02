-- 0000 — Extensions requises AVANT le schéma.
-- citext : courriels insensibles à la casse avec vraie contrainte d'unicité.
-- (gen_random_uuid() est natif depuis Postgres 13, aucune extension requise.)
CREATE EXTENSION IF NOT EXISTS citext;
