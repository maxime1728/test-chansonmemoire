CREATE TYPE "public"."commercial_status" AS ENUM('preview_only', 'purchased', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."consent_status" AS ENUM('received', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."demande_etat" AS ENUM('recue', 'analysee_ia', 'en_validation', 'approuvee', 'en_generation', 'prete', 'livree', 'confirmee_recue', 'rejetee_ia', 'expiree');--> statement-breakpoint
CREATE TYPE "public"."generation_status" AS ENUM('lyrics_generated', 'audio_pending', 'audio_generated', 'validated', 'failed');--> statement-breakpoint
CREATE TYPE "public"."generation_type" AS ENUM('lyrics', 'lyrics_regeneration', 'song', 'song_regeneration', 'cover');--> statement-breakpoint
CREATE TYPE "public"."upsell_status" AS ENUM('purchased', 'delivered', 'refunded', 'failed');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"record_id" uuid,
	"action" text NOT NULL,
	"old_data" jsonb,
	"new_data" jsonb,
	"acteur" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"contact_name" text,
	"first_contact_date" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_date" timestamp with time zone,
	"consent_status" "consent_status" DEFAULT 'received' NOT NULL,
	"consent_date" timestamp with time zone,
	"marketing_optout_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"client_id" uuid,
	"demande_id" uuid,
	"direction" text NOT NULL,
	"sujet" text,
	"corps" text,
	"statut" text,
	"mailgun_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "conversations_direction_valide" CHECK ("conversations"."direction" in ('entrant', 'sortant'))
);
--> statement-breakpoint
CREATE TABLE "courriels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"project_id" uuid,
	"conversation_id" uuid,
	"type" text DEFAULT 'transactionnel' NOT NULL,
	"destinataire" "citext" NOT NULL,
	"sujet" text,
	"mailgun_message_id" text,
	"statut" text DEFAULT 'envoye' NOT NULL,
	"envoye_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"bounce_at" timestamp with time zone,
	"erreur" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "courriels_statut_valide" CHECK ("courriels"."statut" in ('envoye', 'delivered', 'opened', 'bounced', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "demande_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"demande_id" uuid NOT NULL,
	"version_analyse" integer NOT NULL,
	"analyse_ia" jsonb NOT NULL,
	"prompt_version" text,
	"modele" text,
	"cout_ia_cents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demande_analyses_version_unq" UNIQUE("demande_id","version_analyse"),
	CONSTRAINT "demande_analyses_version_positive" CHECK ("demande_analyses"."version_analyse" > 0)
);
--> statement-breakpoint
CREATE TABLE "demandes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"generation_id" uuid,
	"etat" "demande_etat" DEFAULT 'recue' NOT NULL,
	"type" text DEFAULT 'chanson' NOT NULL,
	"mode" text,
	"nouvelle_chanson" boolean DEFAULT false NOT NULL,
	"canal" text DEFAULT 'formulaire' NOT NULL,
	"demande_brute" text NOT NULL,
	"analyse_ia" jsonb,
	"confiance_globale" numeric(5, 4),
	"paroles_proposees" text,
	"paroles_phonetiques" text,
	"courriel_propose" text,
	"modifications_humaines" jsonb,
	"version_analyse" integer DEFAULT 0 NOT NULL,
	"prompt_version" text,
	"cout_ia_cents" integer,
	"etat_depuis" timestamp with time zone DEFAULT now() NOT NULL,
	"recue_at" timestamp with time zone DEFAULT now() NOT NULL,
	"analysee_at" timestamp with time zone,
	"en_validation_at" timestamp with time zone,
	"approuvee_at" timestamp with time zone,
	"en_generation_at" timestamp with time zone,
	"prete_at" timestamp with time zone,
	"livree_at" timestamp with time zone,
	"confirmee_at" timestamp with time zone,
	"rejetee_at" timestamp with time zone,
	"expiree_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "demandes_type_valide" CHECK ("demandes"."type" in ('paroles', 'chanson', 'video', 'cover')),
	CONSTRAINT "demandes_mode_valide" CHECK ("demandes"."mode" is null or "demandes"."mode" in ('cover', 'regeneration')),
	CONSTRAINT "demandes_canal_valide" CHECK ("demandes"."canal" in ('formulaire', 'courriel', 'cockpit', 'canari')),
	CONSTRAINT "demandes_confiance_bornee" CHECK ("demandes"."confiance_globale" is null or ("demandes"."confiance_globale" >= 0 and "demandes"."confiance_globale" <= 1)),
	CONSTRAINT "demandes_cout_positif" CHECK ("demandes"."cout_ia_cents" is null or "demandes"."cout_ia_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "dictionnaire_prononciation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mot" text NOT NULL,
	"graphie_phonetique" text NOT NULL,
	"contexte" text DEFAULT 'global' NOT NULL,
	"source_demande_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "dictionnaire_mot_contexte_unq" UNIQUE("mot","contexte")
);
--> statement-breakpoint
CREATE TABLE "evenements_livraison" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"demande_id" uuid,
	"generation_id" uuid,
	"courriel_id" uuid,
	"type" text NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evenements_livraison_type_valide" CHECK ("evenements_livraison"."type" in ('courriel_envoye', 'courriel_ouvert', 'page_visitee', 'lecture_demarree'))
);
--> statement-breakpoint
CREATE TABLE "generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"generation_no" integer NOT NULL,
	"type" "generation_type" NOT NULL,
	"post_purchase" boolean DEFAULT false NOT NULL,
	"admin_triggered" boolean DEFAULT false NOT NULL,
	"suno_task_id" text,
	"song_id" text,
	"lyrics" text,
	"lyrics_phonetique" text,
	"song_title" text,
	"requested_changes" text,
	"status" "generation_status" DEFAULT 'lyrics_generated' NOT NULL,
	"gen_music_style" text,
	"gen_mood" text,
	"gen_voice" text,
	"style_prompt" text,
	"cloudinary_audio_url" text,
	"incident_status" text,
	"incident_detail" text,
	"incident_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "generations_project_no_unq" UNIQUE("project_id","generation_no"),
	CONSTRAINT "generations_no_positif" CHECK ("generations"."generation_no" > 0)
);
--> statement-breakpoint
CREATE TABLE "inscriptions_sequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"email" "citext" NOT NULL,
	"sequence" text NOT NULL,
	"etape" integer DEFAULT 0 NOT NULL,
	"statut" text DEFAULT 'active' NOT NULL,
	"derniere_etape_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "inscriptions_email_sequence_unq" UNIQUE("email","sequence"),
	CONSTRAINT "inscriptions_statut_valide" CHECK ("inscriptions_sequences"."statut" in ('active', 'terminee', 'desabonnee'))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"deceased_name" text NOT NULL,
	"relationship" text,
	"music_style" text,
	"voice" text,
	"mood" text,
	"occasion" text DEFAULT 'memorial',
	"what_made_unique" text,
	"memories" text,
	"memory_to_keep" text,
	"language" text DEFAULT 'fr-CA' NOT NULL,
	"song_type" text DEFAULT 'hommage' NOT NULL,
	"funnel_step" text,
	"commercial_status" "commercial_status" DEFAULT 'preview_only' NOT NULL,
	"amount" numeric(10, 2),
	"purchase_date" timestamp with time zone,
	"cgv_acceptees_at" timestamp with time zone,
	"recevoir_clicked_at" timestamp with time zone,
	"delivery_signature_name" text,
	"delivery_signature_at" timestamp with time zone,
	"delivery_accessed_at" timestamp with time zone,
	"acceptance_ip" "inet",
	"acceptance_user_agent" text,
	"downloaded_at" timestamp with time zone,
	"download_count" integer DEFAULT 0 NOT NULL,
	"purchased_generation_no" integer,
	"stripe_session_id" text,
	"stripe_payment_intent" text,
	"attribution" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "projects_amount_positif" CHECK ("projects"."amount" is null or "projects"."amount" >= 0),
	CONSTRAINT "projects_song_type_valide" CHECK ("projects"."song_type" in ('hommage', 'cadeau')),
	CONSTRAINT "projects_purchased_generation_no_positif" CHECK ("projects"."purchased_generation_no" is null or "projects"."purchased_generation_no" > 0)
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stripe_event_id" text NOT NULL,
	"type" text NOT NULL,
	"traite" boolean DEFAULT false NOT NULL,
	"traite_at" timestamp with time zone,
	"payload" jsonb,
	"erreur" text,
	"recu_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upsells" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"type" text NOT NULL,
	"price" numeric(10, 2),
	"status" "upsell_status" DEFAULT 'purchased' NOT NULL,
	"purchase_date" timestamp with time zone DEFAULT now() NOT NULL,
	"task_id" text,
	"delivery_url" text,
	"stripe_session_id" text,
	"stripe_payment_intent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "upsells_price_positif" CHECK ("upsells"."price" is null or "upsells"."price" >= 0),
	CONSTRAINT "upsells_type_valide" CHECK ("upsells"."type" in ('video_memoire', 'lyrics_pdf', 'instrumental', 'paroles_vivantes', 'signet', 'plaque_indoor', 'plaque_outdoor'))
);
--> statement-breakpoint
CREATE TABLE "waitlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"projet_honore" text,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_demande_id_demandes_id_fk" FOREIGN KEY ("demande_id") REFERENCES "public"."demandes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courriels" ADD CONSTRAINT "courriels_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courriels" ADD CONSTRAINT "courriels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courriels" ADD CONSTRAINT "courriels_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demande_analyses" ADD CONSTRAINT "demande_analyses_demande_id_demandes_id_fk" FOREIGN KEY ("demande_id") REFERENCES "public"."demandes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demandes" ADD CONSTRAINT "demandes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demandes" ADD CONSTRAINT "demandes_generation_id_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dictionnaire_prononciation" ADD CONSTRAINT "dictionnaire_prononciation_source_demande_id_demandes_id_fk" FOREIGN KEY ("source_demande_id") REFERENCES "public"."demandes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evenements_livraison" ADD CONSTRAINT "evenements_livraison_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evenements_livraison" ADD CONSTRAINT "evenements_livraison_demande_id_demandes_id_fk" FOREIGN KEY ("demande_id") REFERENCES "public"."demandes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evenements_livraison" ADD CONSTRAINT "evenements_livraison_generation_id_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evenements_livraison" ADD CONSTRAINT "evenements_livraison_courriel_id_courriels_id_fk" FOREIGN KEY ("courriel_id") REFERENCES "public"."courriels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inscriptions_sequences" ADD CONSTRAINT "inscriptions_sequences_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upsells" ADD CONSTRAINT "upsells_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_table_record_idx" ON "audit_log" USING btree ("table_name","record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_email_unq" ON "clients" USING btree ("email");--> statement-breakpoint
CREATE INDEX "conversations_project_id_idx" ON "conversations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "conversations_client_id_idx" ON "conversations" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "courriels_project_id_idx" ON "courriels" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "courriels_mailgun_message_id_unq" ON "courriels" USING btree ("mailgun_message_id") WHERE "courriels"."mailgun_message_id" is not null;--> statement-breakpoint
CREATE INDEX "demandes_project_id_idx" ON "demandes" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "demandes_etat_depuis_idx" ON "demandes" USING btree ("etat","etat_depuis");--> statement-breakpoint
CREATE INDEX "evenements_livraison_project_type_idx" ON "evenements_livraison" USING btree ("project_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "generations_suno_task_id_unq" ON "generations" USING btree ("suno_task_id") WHERE "generations"."suno_task_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_token_unq" ON "projects" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_stripe_payment_intent_unq" ON "projects" USING btree ("stripe_payment_intent") WHERE "projects"."stripe_payment_intent" is not null;--> statement-breakpoint
CREATE INDEX "projects_client_id_idx" ON "projects" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "projects_commercial_status_idx" ON "projects" USING btree ("commercial_status");--> statement-breakpoint
CREATE INDEX "projects_attribution_gin" ON "projects" USING gin ("attribution");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_events_event_id_unq" ON "stripe_events" USING btree ("stripe_event_id");--> statement-breakpoint
CREATE INDEX "upsells_project_id_idx" ON "upsells" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "upsells_task_id_unq" ON "upsells" USING btree ("task_id") WHERE "upsells"."task_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_email_unq" ON "waitlist" USING btree ("email");