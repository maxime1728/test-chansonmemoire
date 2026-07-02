// _lib/analyse.ts — analyse d'une demande de révision (v2 Supabase, pipeline IA).
//
// PORTAGE de analyserModif (_lib/analyse-modif.js) : même modèle, même parsing, même
// normalisation de sortie. Différence v2 : plus de best-effort silencieux (« ok:false »
// muet) : l'appelant journalise et route ; le brut complet est conservé pour
// demandes.analyse_ia et demande_analyses (le futur jeu d'entraînement de Maxime).
import { journaliser } from './journal';
import { PROMPT_VERSION_ANALYSE, SYSTEM_ANALYSE, userPromptAnalyse, type ContexteAnalyse } from './prompts/analyse';

export interface ResultatAnalyse {
  ok: boolean;
  brut: Record<string, unknown> | null; // JSON complet du modèle (analyse_ia)
  nouvelleChanson: boolean;
  categories: string[];
  mode: 'cover' | 'regeneration';
  compteRendu: string;
  adjStyle: string;
  adjLyrics: string;
  phonetique: string;
  prononciations: Array<{ mot: string; phonetique: string }>;
  promptVersion: string;
}

export async function analyserRevision(params: {
  demande: string;
  projet: ContexteAnalyse;
  gen: ContexteAnalyse;
  styleActuel: string;
  catalogue: Array<{ style: string; prompt: string }>;
}): Promise<ResultatAnalyse> {
  const defaut: ResultatAnalyse = {
    ok: false,
    brut: null,
    nouvelleChanson: false,
    categories: [],
    mode: 'cover',
    compteRendu: '',
    adjStyle: params.styleActuel || '',
    adjLyrics: '',
    phonetique: '',
    prononciations: [],
    promptVersion: PROMPT_VERSION_ANALYSE,
  };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !params.demande) return defaut;

  let parsed: Record<string, unknown> | null = null;
  try {
    const rC = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        system: SYSTEM_ANALYSE,
        messages: [{ role: 'user', content: userPromptAnalyse(params.demande, params.projet, params.gen, params.styleActuel, params.catalogue) }],
      }),
    });
    const data = (await rC.json()) as { content?: Array<{ type?: string; text?: string }> };
    if (rC.ok) {
      let txt = (data.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
        .trim();
      txt = txt.replace(/```json/gi, '').replace(/```/g, '').trim();
      const a = txt.indexOf('{');
      const z = txt.lastIndexOf('}');
      if (a !== -1 && z !== -1 && z > a) txt = txt.slice(a, z + 1);
      try {
        parsed = JSON.parse(txt) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    } else {
      journaliser({ niveau: 'P2', fonction: 'analyse', message: `Anthropic KO (HTTP ${rC.status})` });
    }
  } catch (e) {
    journaliser({ niveau: 'P2', fonction: 'analyse', message: `analyse échouée: ${e instanceof Error ? e.message : String(e)}` });
    parsed = null;
  }
  if (!parsed) return defaut;

  // Normalisation IDENTIQUE au legacy (mêmes bornes), + brut conservé.
  const prononciations = Array.isArray(parsed.prononciations)
    ? (parsed.prononciations as Array<{ mot?: unknown; phonetique?: unknown }>)
        .filter((x) => x && x.mot && x.phonetique)
        .map((x) => ({ mot: String(x.mot).trim().slice(0, 80), phonetique: String(x.phonetique).trim().slice(0, 80) }))
        .slice(0, 20)
    : [];
  return {
    ok: true,
    brut: parsed,
    nouvelleChanson: parsed.nouvelle_chanson === true,
    categories: Array.isArray(parsed.categories) ? (parsed.categories as unknown[]).map(String) : [],
    mode: parsed.mode === 'regeneration' ? 'regeneration' : 'cover',
    compteRendu: String(parsed.compte_rendu || '').slice(0, 3000),
    adjStyle: String(parsed.adjusted_style_prompt || '').slice(0, 2500) || params.styleActuel || '',
    adjLyrics: String(parsed.adjusted_lyrics || '').slice(0, 6000),
    phonetique: String(parsed.lyrics_phonetique || '').slice(0, 6000),
    prononciations,
    promptVersion: PROMPT_VERSION_ANALYSE,
  };
}
