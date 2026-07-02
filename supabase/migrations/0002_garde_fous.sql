-- =============================================================================
-- 0002 — Garde-fous : updated_at automatique, audit_log par triggers,
-- Row Level Security, vues soft-delete, vue des plafonds.
-- Réf. : docs/supabase-evaluation/plan-migration-supabase-v2.md (§4) et rls-portee.md.
-- =============================================================================

-- ── 1. updated_at maintenu par trigger (jamais par l'app : impossible à oublier) ──
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_clients_updated_at BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_projects_updated_at BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_generations_updated_at BEFORE UPDATE ON generations FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_upsells_updated_at BEFORE UPDATE ON upsells FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_demandes_updated_at BEFORE UPDATE ON demandes FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_conversations_updated_at BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_courriels_updated_at BEFORE UPDATE ON courriels FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_dictionnaire_updated_at BEFORE UPDATE ON dictionnaire_prononciation FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_inscriptions_updated_at BEFORE UPDATE ON inscriptions_sequences FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint

-- ── 2. etat_depuis : remis à now() à CHAQUE changement d'état d'une demande.
--       C'est l'horloge du watchdog (état intermédiaire trop vieux = alerte). ──
CREATE OR REPLACE FUNCTION fn_demandes_etat_depuis()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.etat IS DISTINCT FROM OLD.etat THEN
    NEW.etat_depuis := now();
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_demandes_etat_depuis BEFORE UPDATE ON demandes FOR EACH ROW EXECUTE FUNCTION fn_demandes_etat_depuis();
--> statement-breakpoint

-- ── 3. audit_log — Phase 1 : argent / commande / demandes SEULEMENT
--       (projects, upsells, demandes). L'acteur est posé par l'app via
--       set_config('app.acteur', ..., true) dans la transaction ; sinon 'system'. ──
CREATE OR REPLACE FUNCTION fn_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_record_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_record_id := OLD.id;
  ELSE
    v_record_id := NEW.id;
  END IF;
  INSERT INTO audit_log (table_name, record_id, action, old_data, new_data, acteur)
  VALUES (
    TG_TABLE_NAME,
    v_record_id,
    TG_OP,
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END,
    COALESCE(NULLIF(current_setting('app.acteur', true), ''), 'system')
  );
  RETURN NULL; -- trigger AFTER : la valeur de retour est ignorée
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_projects_audit AFTER INSERT OR UPDATE OR DELETE ON projects FOR EACH ROW EXECUTE FUNCTION fn_audit();
--> statement-breakpoint
CREATE TRIGGER trg_upsells_audit AFTER INSERT OR UPDATE OR DELETE ON upsells FOR EACH ROW EXECUTE FUNCTION fn_audit();
--> statement-breakpoint
CREATE TRIGGER trg_demandes_audit AFTER INSERT OR UPDATE OR DELETE ON demandes FOR EACH ROW EXECUTE FUNCTION fn_audit();
--> statement-breakpoint

-- ── 4. Row Level Security — activé PARTOUT, aucune policy permissive.
--       Portée réelle (docs/supabase-evaluation/rls-portee.md) : les fonctions
--       Netlify passent en service_role qui BYPASSE RLS ; la sécurité runtime
--       est le code. RLS + REVOKE ferment la surface PostgREST (clé anon). ──
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE generations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE upsells ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE demandes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE demande_analyses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE courriels ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE evenements_livraison ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE dictionnaire_prononciation ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE inscriptions_sequences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Ceinture + bretelles : même si une policy permissive apparaissait un jour,
-- les rôles publics de PostgREST n'ont AUCUN privilège sur nos tables.
-- (Rôles standard Supabase ; no-op inoffensif sur un Postgres nu type CI.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
  END IF;
END
$$;
--> statement-breakpoint

-- ── 5. Vues soft-delete — le filtre deleted_at IS NULL ne peut PAS être oublié :
--       les lectures applicatives passent par ces vues ou par le helper actif()
--       de _lib/db.ts. (security_invoker : la vue n'escalade aucun privilège.) ──
CREATE VIEW clients_actifs WITH (security_invoker = true) AS
  SELECT * FROM clients WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE VIEW projects_actifs WITH (security_invoker = true) AS
  SELECT * FROM projects WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE VIEW generations_actives WITH (security_invoker = true) AS
  SELECT * FROM generations WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE VIEW upsells_actifs WITH (security_invoker = true) AS
  SELECT * FROM upsells WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE VIEW demandes_actives WITH (security_invoker = true) AS
  SELECT * FROM demandes WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE VIEW conversations_actives WITH (security_invoker = true) AS
  SELECT * FROM conversations WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE VIEW courriels_actifs WITH (security_invoker = true) AS
  SELECT * FROM courriels WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE VIEW dictionnaire_actif WITH (security_invoker = true) AS
  SELECT * FROM dictionnaire_prononciation WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE VIEW inscriptions_actives WITH (security_invoker = true) AS
  SELECT * FROM inscriptions_sequences WHERE deleted_at IS NULL;
--> statement-breakpoint

-- ── 6. Plafonds — la règle v2 de _lib/comptage.js (tranchée 2026-06-30) en SQL.
--       Un appel Suno LIVRÉ compte 1 (status audio_generated ou validated,
--       type chanson/régé/cover), JAMAIS si déclenché admin, pré/post séparés.
--       L'exemption legacy correction_paroles_seules N'EST PAS portée (décision
--       étape 0). Toujours juste, zéro cron de recomptage. Plafond appliqué
--       par le code (PLAFOND_SUNO = 4), la vue fournit les comptes. ──
CREATE VIEW project_counts WITH (security_invoker = true) AS
SELECT
  p.id AS project_id,
  p.token,
  COUNT(g.*) FILTER (
    WHERE g.status IN ('audio_generated', 'validated')
      AND g.type IN ('song', 'song_regeneration', 'cover')
      AND NOT g.admin_triggered
      AND NOT g.post_purchase
      AND g.deleted_at IS NULL
  ) AS appels_suno_pre,
  COUNT(g.*) FILTER (
    WHERE g.status IN ('audio_generated', 'validated')
      AND g.type IN ('song', 'song_regeneration', 'cover')
      AND NOT g.admin_triggered
      AND g.post_purchase
      AND g.deleted_at IS NULL
  ) AS appels_suno_post
FROM projects p
LEFT JOIN generations g ON g.project_id = p.id
WHERE p.deleted_at IS NULL
GROUP BY p.id, p.token;
