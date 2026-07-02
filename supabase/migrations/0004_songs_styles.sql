CREATE TABLE "songs_styles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"style_musical" text NOT NULL,
	"ambiance" text NOT NULL,
	"cadeau_memoire" text NOT NULL,
	"prompt_complet" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "songs_styles_combo_unq" UNIQUE("style_musical","ambiance","cadeau_memoire"),
	CONSTRAINT "songs_styles_type_valide" CHECK ("songs_styles"."cadeau_memoire" in ('Cadeau', 'Mémoire'))
);
