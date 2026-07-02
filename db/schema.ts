// =============================================================================
// Chanson Mémoire — SOURCE DE VÉRITÉ du schéma Postgres (Supabase).
// Phase 1 du plan docs/supabase-evaluation/plan-migration-supabase-v2.md.
//
// Règles dures appliquées ici (le reste vit dans les migrations SQL custom) :
//   - Argent : numeric (revient en STRING de postgres.js, jamais de parseFloat), CHECK >= 0.
//   - Dates : timestamptz UTC partout, mode 'string' côté JS (aucune conversion implicite).
//   - Idempotence PAR CONTRAINTE : UNIQUE sur token, email, stripe_event_id, suno_task_id,
//     (project_id, generation_no), (demande_id, version_analyse), (mot, contexte).
//   - FK avec ON DELETE explicite : 'cascade' UNIQUEMENT sous projects (voulu : la purge
//     Loi 25 emporte tout le dossier d'un projet), 'restrict' clients->projects,
//     'set null' pour les références de traçabilité.
//   - Soft-delete : deleted_at sur toutes les tables métier. Les lectures passent par les
//     vues *_actifs (migration 0002) ou le helper actif() de _lib/db.ts.
//   - Enums Postgres pour les MACHINES À ÉTATS (stables) ; CHECK pour les types produit
//     (extensibles sans migration d'enum) : song_type, upsell.type, demandes.type.
//
// Toute modification de ce fichier passe par : `npm run db:generate` (nouvelle migration
// SQL versionnée) + PR. La CI casse si schéma et migrations divergent (drizzle-kit check).
// =============================================================================
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ── Types Postgres absents de drizzle ────────────────────────────────────────
// citext = texte insensible à la casse : l'unicité d'un courriel devient une vraie
// contrainte (fini l'upsert bricolé par formule). Extension activée en migration 0000.
const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});
const inet = customType<{ data: string }>({
  dataType() {
    return 'inet';
  },
});

// ── Colonnes d'horodatage communes (soft-delete inclus) ─────────────────────
const tz = (nom: string) => timestamp(nom, { withTimezone: true, mode: 'string' });
const horodatage = () => ({
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(), // maintenu par trigger (migration 0002)
  deletedAt: tz('deleted_at'),
});

// ── Enums (machines à états, stables) ────────────────────────────────────────
export const commercialStatusEnum = pgEnum('commercial_status', [
  'preview_only',
  'purchased',
  'refunded',
]);
export const consentStatusEnum = pgEnum('consent_status', ['received', 'withdrawn']);
export const generationTypeEnum = pgEnum('generation_type', [
  'lyrics',
  'lyrics_regeneration',
  'song',
  'song_regeneration',
  'cover',
]);
// 'failed' ajouté vs schema.sql d'évaluation : le code réel (sentinelle) a des échecs permanents.
export const generationStatusEnum = pgEnum('generation_status', [
  'lyrics_generated',
  'audio_pending',
  'audio_generated',
  'validated',
  'failed',
]);
export const upsellStatusEnum = pgEnum('upsell_status', [
  'purchased',
  'delivered',
  'refunded',
  'failed',
]);
// Machine à états de la table demandes (plan v2 §4, objet central du cockpit Phase 2).
export const demandeEtatEnum = pgEnum('demande_etat', [
  'recue',
  'analysee_ia',
  'en_validation',
  'approuvee',
  'en_generation',
  'prete',
  'livree',
  'confirmee_recue',
  'rejetee_ia',
  'expiree',
]);

// =============================================================================
// CLIENTS
// =============================================================================
export const clients = pgTable(
  'clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: citext('email').notNull(),
    contactName: text('contact_name'),
    firstContactDate: tz('first_contact_date').notNull().defaultNow(),
    lastActivityDate: tz('last_activity_date'),
    consentStatus: consentStatusEnum('consent_status').notNull().default('received'),
    consentDate: tz('consent_date'),
    // Désabonnement marketing (distinct du retrait de consentement Loi 25).
    marketingOptoutAt: tz('marketing_optout_at'),
    ...horodatage(),
  },
  (t) => [uniqueIndex('clients_email_unq').on(t.email)],
);

// =============================================================================
// PROJECTS — 1 token = 1 projet = 1 personne honorée. Le token UUID est LA clé
// d'accès applicative (jamais l'id interne, jamais de record ID dans une URL).
// =============================================================================
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    token: uuid('token').notNull().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'restrict' }),
    deceasedName: text('deceased_name').notNull(),
    relationship: text('relationship'),
    musicStyle: text('music_style'),
    voice: text('voice'),
    mood: text('mood'),
    occasion: text('occasion').default('memorial'),
    whatMadeUnique: text('what_made_unique'),
    memories: text('memories'),
    memoryToKeep: text('memory_to_keep'),
    language: text('language').notNull().default('fr-CA'),
    // Valeurs réelles du code actuel : 'hommage' (défaut) et 'cadeau'.
    songType: text('song_type').notNull().default('hommage'),
    funnelStep: text('funnel_step'),
    commercialStatus: commercialStatusEnum('commercial_status').notNull().default('preview_only'),
    amount: numeric('amount', { precision: 10, scale: 2 }),
    purchaseDate: tz('purchase_date'),
    // Preuve de consentement / livraison (Loi 25) — toujours des timestamps SERVEUR.
    cgvAccepteesAt: tz('cgv_acceptees_at'),
    recevoirClickedAt: tz('recevoir_clicked_at'),
    deliverySignatureName: text('delivery_signature_name'),
    deliverySignatureAt: tz('delivery_signature_at'),
    deliveryAccessedAt: tz('delivery_accessed_at'),
    acceptanceIp: inet('acceptance_ip'),
    acceptanceUserAgent: text('acceptance_user_agent'),
    downloadedAt: tz('downloaded_at'),
    downloadCount: integer('download_count').notNull().default(0),
    // Version achetée (racine du bug « version achetée non promue » : ici c'est une vraie
    // colonne, cohérente avec unique(project_id, generation_no) sur generations).
    purchasedGenerationNo: integer('purchased_generation_no'),
    stripeSessionId: text('stripe_session_id'),
    stripePaymentIntent: text('stripe_payment_intent'),
    attribution: jsonb('attribution').notNull().default({}),
    ...horodatage(),
  },
  (t) => [
    uniqueIndex('projects_token_unq').on(t.token),
    uniqueIndex('projects_stripe_payment_intent_unq')
      .on(t.stripePaymentIntent)
      .where(sql`${t.stripePaymentIntent} is not null`),
    index('projects_client_id_idx').on(t.clientId),
    index('projects_commercial_status_idx').on(t.commercialStatus),
    index('projects_attribution_gin').using('gin', t.attribution),
    check('projects_amount_positif', sql`${t.amount} is null or ${t.amount} >= 0`),
    check('projects_song_type_valide', sql`${t.songType} in ('hommage', 'cadeau')`),
    check(
      'projects_purchased_generation_no_positif',
      sql`${t.purchasedGenerationNo} is null or ${t.purchasedGenerationNo} > 0`,
    ),
  ],
);

// =============================================================================
// GENERATIONS — chaque appel paroles/Suno = une ligne. Le match d'un callback
// Suno se fait par contrainte UNIQUE (course entre deux callbacks impossible).
// =============================================================================
export const generations = pgTable(
  'generations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    generationNo: integer('generation_no').notNull(),
    type: generationTypeEnum('type').notNull(),
    postPurchase: boolean('post_purchase').notNull().default(false),
    // Déclenché par l'équipe : ne compte JAMAIS dans les plafonds (règle v2 tranchée 2026-06-30).
    adminTriggered: boolean('admin_triggered').notNull().default(false),
    sunoTaskId: text('suno_task_id'),
    songId: text('song_id'),
    lyrics: text('lyrics'),
    // Paroles envoyées à Suno avec réécritures phonétiques (distinctes des paroles AFFICHÉES).
    lyricsPhonetique: text('lyrics_phonetique'),
    songTitle: text('song_title'),
    requestedChanges: text('requested_changes'),
    status: generationStatusEnum('status').notNull().default('lyrics_generated'),
    genMusicStyle: text('gen_music_style'),
    genMood: text('gen_mood'),
    genVoice: text('gen_voice'),
    // Prompt de style riche réellement envoyé à Suno (adjusted_style_prompt du pipeline IA).
    stylePrompt: text('style_prompt'),
    cloudinaryAudioUrl: text('cloudinary_audio_url'),
    incidentStatus: text('incident_status'),
    incidentDetail: text('incident_detail'),
    incidentAt: tz('incident_at'),
    ...horodatage(),
  },
  (t) => [
    unique('generations_project_no_unq').on(t.projectId, t.generationNo),
    uniqueIndex('generations_suno_task_id_unq')
      .on(t.sunoTaskId)
      .where(sql`${t.sunoTaskId} is not null`),
    check('generations_no_positif', sql`${t.generationNo} > 0`),
  ],
);

// =============================================================================
// UPSELLS — add-ons payants. task_id (Suno instrumentale / Creatomate vidéo…)
// UNIQUE : le watchdog et les callbacks matchent par contrainte, pas par scan.
// =============================================================================
export const upsells = pgTable(
  'upsells',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Valeurs réelles du code : video_memoire, lyrics_pdf, instrumental, paroles_vivantes,
    // signet, plaque_indoor, plaque_outdoor. CHECK (extensible) plutôt qu'enum.
    type: text('type').notNull(),
    price: numeric('price', { precision: 10, scale: 2 }),
    status: upsellStatusEnum('status').notNull().default('purchased'),
    purchaseDate: tz('purchase_date').notNull().defaultNow(),
    taskId: text('task_id'),
    deliveryUrl: text('delivery_url'),
    stripeSessionId: text('stripe_session_id'),
    stripePaymentIntent: text('stripe_payment_intent'),
    ...horodatage(),
  },
  (t) => [
    index('upsells_project_id_idx').on(t.projectId),
    uniqueIndex('upsells_task_id_unq').on(t.taskId).where(sql`${t.taskId} is not null`),
    check('upsells_price_positif', sql`${t.price} is null or ${t.price} >= 0`),
    check(
      'upsells_type_valide',
      sql`${t.type} in ('video_memoire', 'lyrics_pdf', 'instrumental', 'paroles_vivantes', 'signet', 'plaque_indoor', 'plaque_outdoor')`,
    ),
  ],
);

// =============================================================================
// DEMANDES — l'objet central du cockpit (plan v2 §4 et §6). Machine à états +
// analyse IA structurée. analyse_ia épouse le JSON RÉEL de _lib/analyse-modif :
// { nouvelle_chanson, categories[], mode, compte_rendu, adjusted_style_prompt,
//   adjusted_lyrics, lyrics_phonetique, prononciations[{mot, phonetique}],
//   confiances (NOUVEAU Phase 2) }.
// =============================================================================
export const demandes = pgTable(
  'demandes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Génération de référence (version A/B sur laquelle porte la demande).
    generationId: uuid('generation_id').references(() => generations.id, {
      onDelete: 'set null',
    }),
    etat: demandeEtatEnum('etat').notNull().default('recue'),
    // Type produit (extensible ; seul le flux chanson a une UI et un pipeline en v1).
    type: text('type').notNull().default('chanson'),
    // Sorties de routage de l'analyse réelle.
    mode: text('mode'),
    nouvelleChanson: boolean('nouvelle_chanson').notNull().default(false),
    canal: text('canal').notNull().default('formulaire'),
    demandeBrute: text('demande_brute').notNull(),
    // Analyse courante (l'historique versionné vit dans demande_analyses).
    analyseIa: jsonb('analyse_ia'),
    confianceGlobale: numeric('confiance_globale', { precision: 5, scale: 4 }),
    parolesProposees: text('paroles_proposees'),
    parolesPhonetiques: text('paroles_phonetiques'),
    courrielPropose: text('courriel_propose'),
    // Diff entre proposé (IA) et approuvé (humain), capturé à CHAQUE validation :
    // c'est le jeu d'évaluation qui débloquera l'automatisation par catégorie.
    modificationsHumaines: jsonb('modifications_humaines'),
    versionAnalyse: integer('version_analyse').notNull().default(0),
    promptVersion: text('prompt_version'),
    coutIaCents: integer('cout_ia_cents'),
    // Transitions horodatées (timestamptz UTC). etat_depuis = l'horloge du watchdog.
    etatDepuis: tz('etat_depuis').notNull().defaultNow(),
    recueAt: tz('recue_at').notNull().defaultNow(),
    analyseeAt: tz('analysee_at'),
    enValidationAt: tz('en_validation_at'),
    approuveeAt: tz('approuvee_at'),
    enGenerationAt: tz('en_generation_at'),
    preteAt: tz('prete_at'),
    livreeAt: tz('livree_at'),
    confirmeeAt: tz('confirmee_at'),
    rejeteeAt: tz('rejetee_at'),
    expireeAt: tz('expiree_at'),
    ...horodatage(),
  },
  (t) => [
    index('demandes_project_id_idx').on(t.projectId),
    // La file du cockpit : « les plus vieilles dans cet état d'abord ».
    index('demandes_etat_depuis_idx').on(t.etat, t.etatDepuis),
    check('demandes_type_valide', sql`${t.type} in ('paroles', 'chanson', 'video', 'cover')`),
    check('demandes_mode_valide', sql`${t.mode} is null or ${t.mode} in ('cover', 'regeneration')`),
    check(
      'demandes_canal_valide',
      sql`${t.canal} in ('formulaire', 'courriel', 'cockpit', 'canari')`,
    ),
    check(
      'demandes_confiance_bornee',
      sql`${t.confianceGlobale} is null or (${t.confianceGlobale} >= 0 and ${t.confianceGlobale} <= 1)`,
    ),
    check('demandes_cout_positif', sql`${t.coutIaCents} is null or ${t.coutIaCents} >= 0`),
  ],
);

// =============================================================================
// DEMANDE_ANALYSES — historique versionné des analyses IA. La contrainte
// unique(demande_id, version_analyse) = idempotence : une seule analyse par
// demande et par version (exigence plan v2), coût et prompt tracés par appel.
// =============================================================================
export const demandeAnalyses = pgTable(
  'demande_analyses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    demandeId: uuid('demande_id')
      .notNull()
      .references(() => demandes.id, { onDelete: 'cascade' }),
    versionAnalyse: integer('version_analyse').notNull(),
    analyseIa: jsonb('analyse_ia').notNull(),
    promptVersion: text('prompt_version'),
    modele: text('modele'),
    coutIaCents: integer('cout_ia_cents'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('demande_analyses_version_unq').on(t.demandeId, t.versionAnalyse),
    check('demande_analyses_version_positive', sql`${t.versionAnalyse} > 0`),
  ],
);

// =============================================================================
// CONVERSATIONS — fil de communication (support courriel entrant/sortant).
// Distinct de demandes : une conversation PEUT engendrer une demande (bouton
// « nouvelle demande » du cockpit), le lien est tracé ici.
// =============================================================================
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'set null' }),
    demandeId: uuid('demande_id').references(() => demandes.id, { onDelete: 'set null' }),
    direction: text('direction').notNull(),
    sujet: text('sujet'),
    corps: text('corps'),
    statut: text('statut'),
    mailgunMessageId: text('mailgun_message_id'),
    ...horodatage(),
  },
  (t) => [
    index('conversations_project_id_idx').on(t.projectId),
    index('conversations_client_id_idx').on(t.clientId),
    check('conversations_direction_valide', sql`${t.direction} in ('entrant', 'sortant')`),
  ],
);

// =============================================================================
// COURRIELS — journal de chaque envoi + statut Mailgun (delivered/opened/bounce).
// Un bounce sur un courriel de livraison = P1 (voir docs/supabase-evaluation/observabilite.md).
// =============================================================================
export const courriels = pgTable(
  'courriels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'set null' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    type: text('type').notNull().default('transactionnel'),
    destinataire: citext('destinataire').notNull(),
    sujet: text('sujet'),
    mailgunMessageId: text('mailgun_message_id'),
    statut: text('statut').notNull().default('envoye'),
    envoyeAt: tz('envoye_at').notNull().defaultNow(),
    deliveredAt: tz('delivered_at'),
    openedAt: tz('opened_at'),
    bounceAt: tz('bounce_at'),
    erreur: text('erreur'),
    meta: jsonb('meta'),
    ...horodatage(),
  },
  (t) => [
    index('courriels_project_id_idx').on(t.projectId),
    uniqueIndex('courriels_mailgun_message_id_unq')
      .on(t.mailgunMessageId)
      .where(sql`${t.mailgunMessageId} is not null`),
    check(
      'courriels_statut_valide',
      sql`${t.statut} in ('envoye', 'delivered', 'opened', 'bounced', 'failed')`,
    ),
  ],
);

// =============================================================================
// EVENEMENTS_LIVRAISON — les 4 signaux de réception (plan v2 §4). « Courriel
// envoyé » ne prouve rien : la boucle est fermée à la preuve de réception.
// =============================================================================
export const evenementsLivraison = pgTable(
  'evenements_livraison',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    demandeId: uuid('demande_id').references(() => demandes.id, { onDelete: 'set null' }),
    generationId: uuid('generation_id').references(() => generations.id, {
      onDelete: 'set null',
    }),
    courrielId: uuid('courriel_id').references(() => courriels.id, { onDelete: 'set null' }),
    type: text('type').notNull(),
    meta: jsonb('meta'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('evenements_livraison_project_type_idx').on(t.projectId, t.type),
    check(
      'evenements_livraison_type_valide',
      sql`${t.type} in ('courriel_envoye', 'courriel_ouvert', 'page_visitee', 'lecture_demarree')`,
    ),
  ],
);

// =============================================================================
// DICTIONNAIRE_PRONONCIATION — actif cumulatif : chaque correction devient
// permanente. Appliqué par une passe de remplacement AVANT chaque appel Suno.
// Alimenté en un clic depuis le cockpit (le champ prononciations[] de
// l'analyse IA a déjà exactement ce format).
// =============================================================================
export const dictionnairePrononciation = pgTable(
  'dictionnaire_prononciation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mot: text('mot').notNull(),
    graphiePhonetique: text('graphie_phonetique').notNull(),
    // 'global' ou un token/portée projet (décision mémoire : portée projet/global).
    contexte: text('contexte').notNull().default('global'),
    sourceDemandeId: uuid('source_demande_id').references(() => demandes.id, {
      onDelete: 'set null',
    }),
    ...horodatage(),
  },
  (t) => [unique('dictionnaire_mot_contexte_unq').on(t.mot, t.contexte)],
);

// =============================================================================
// STRIPE_EVENTS — idempotence webhook PAR CONTRAINTE. Le webhook INSÈRE l'event
// AVANT de traiter ; doublon (retry Stripe, double livraison d'event) = conflit
// UNIQUE = no-op loggé. Append-only : pas de soft-delete.
// =============================================================================
export const stripeEvents = pgTable(
  'stripe_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stripeEventId: text('stripe_event_id').notNull(),
    type: text('type').notNull(),
    traite: boolean('traite').notNull().default(false),
    traiteAt: tz('traite_at'),
    payload: jsonb('payload'),
    erreur: text('erreur'),
    recuAt: tz('recu_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('stripe_events_event_id_unq').on(t.stripeEventId)],
);

// =============================================================================
// AUDIT_LOG — rempli par triggers (migration 0002) sur argent/commande/demandes
// SEULEMENT en Phase 1 : projects, upsells, demandes. Append-only.
// =============================================================================
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tableName: text('table_name').notNull(),
    recordId: uuid('record_id'),
    action: text('action').notNull(),
    oldData: jsonb('old_data'),
    newData: jsonb('new_data'),
    // Posé par l'app via set_config('app.acteur', ...) ; 'system' sinon.
    acteur: text('acteur'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [index('audit_log_table_record_idx').on(t.tableName, t.recordId)],
);

// =============================================================================
// WAITLIST — inscriptions page-souvenir (rejoindre-waitlist).
// =============================================================================
export const waitlist = pgTable(
  'waitlist',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: citext('email').notNull(),
    projetHonore: text('projet_honore'),
    source: text('source'),
    createdAt: tz('created_at').notNull().defaultNow(),
    deletedAt: tz('deleted_at'),
  },
  (t) => [uniqueIndex('waitlist_email_unq').on(t.email)],
);

// =============================================================================
// INSCRIPTIONS_SEQUENCES — moteur multi-séquences courriel (sequences-cron).
// unique(email, sequence) : impossible d'inscrire deux fois au même parcours.
// =============================================================================
export const inscriptionsSequences = pgTable(
  'inscriptions_sequences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'set null' }),
    email: citext('email').notNull(),
    sequence: text('sequence').notNull(),
    etape: integer('etape').notNull().default(0),
    statut: text('statut').notNull().default('active'),
    derniereEtapeAt: tz('derniere_etape_at'),
    ...horodatage(),
  },
  (t) => [
    unique('inscriptions_email_sequence_unq').on(t.email, t.sequence),
    check(
      'inscriptions_statut_valide',
      sql`${t.statut} in ('active', 'terminee', 'desabonnee')`,
    ),
  ],
);

// ── Types TypeScript générés depuis le schéma (source unique de vérité) ─────
export type Client = typeof clients.$inferSelect;
export type NouveauClient = typeof clients.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NouveauProject = typeof projects.$inferInsert;
export type Generation = typeof generations.$inferSelect;
export type NouvelleGeneration = typeof generations.$inferInsert;
export type Upsell = typeof upsells.$inferSelect;
export type Demande = typeof demandes.$inferSelect;
export type NouvelleDemande = typeof demandes.$inferInsert;
export type DemandeAnalyse = typeof demandeAnalyses.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Courriel = typeof courriels.$inferSelect;
export type EvenementLivraison = typeof evenementsLivraison.$inferSelect;
export type EntreeDictionnaire = typeof dictionnairePrononciation.$inferSelect;
export type StripeEvent = typeof stripeEvents.$inferSelect;
export type EntreeAudit = typeof auditLog.$inferSelect;
