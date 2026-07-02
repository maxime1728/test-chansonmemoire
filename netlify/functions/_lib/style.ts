// _lib/style.ts — prompt de style Suno curé (v2 Supabase).
//
// PORTAGE de _lib/style.js : même logique, la table « Songs_Styles » d'Airtable est
// devenue la table `songs_styles` (seedée par la migration 0005 : 195 combinaisons).
// Les prompts curés sont écrits en accent québécois ; on adapte l'accent à la langue.
// REPLI SÛR conservé : combinaison introuvable ou pépin -> `music_style, mood, accent`
// (la génération ne dépend JAMAIS du catalogue).
import { and, eq } from 'drizzle-orm';
import { db, actif, schema } from './db';
import { accentFor } from './lyrics';

const QC_ACCENT = 'Quebec French accent, Canadian French';
const ACCENT_SWAP: Record<string, string> = {
  'fr-FR': 'French (France) accent',
  en: 'English',
  es: 'Spanish',
};

export interface ParamsStyle {
  music_style?: string | null;
  mood?: string | null;
  cadeau: boolean;
  language?: string | null;
}

// Renvoie le prompt de style Suno. Toujours une chaîne non vide (repli garanti).
export async function styleFor(p: ParamsStyle): Promise<string> {
  const fallback = [p.music_style, p.mood, accentFor(p.language)].filter(Boolean).join(', ');
  try {
    if (!p.music_style || !p.mood) return fallback;
    const { songsStyles } = schema;
    const [ligne] = await db()
      .select({ prompt: songsStyles.promptComplet })
      .from(songsStyles)
      .where(
        and(
          eq(songsStyles.styleMusical, p.music_style),
          eq(songsStyles.ambiance, p.mood),
          eq(songsStyles.cadeauMemoire, p.cadeau ? 'Cadeau' : 'Mémoire'),
          actif(songsStyles),
        ),
      )
      .limit(1);
    let prompt = (ligne?.prompt || '').trim();
    if (!prompt) return fallback;
    const swap = p.language ? ACCENT_SWAP[p.language] : undefined;
    if (swap) prompt = prompt.split(QC_ACCENT).join(swap); // adapte l'accent selon la langue
    return prompt;
  } catch {
    return fallback; // jamais d'exception : la génération ne dépend pas du catalogue
  }
}

// Catalogue de référence pour UNE ambiance (× Cadeau/Mémoire) : inspiration de l'IA
// quand le client veut un autre style (pipeline révision). Best-effort : [] si pépin.
export async function cataloguePourAmbiance(p: {
  mood?: string | null;
  cadeau: boolean;
  language?: string | null;
}): Promise<Array<{ style: string; prompt: string }>> {
  try {
    if (!p.mood) return [];
    const { songsStyles } = schema;
    const lignes = await db()
      .select({ style: songsStyles.styleMusical, prompt: songsStyles.promptComplet })
      .from(songsStyles)
      .where(
        and(
          eq(songsStyles.ambiance, p.mood),
          eq(songsStyles.cadeauMemoire, p.cadeau ? 'Cadeau' : 'Mémoire'),
          actif(songsStyles),
        ),
      )
      .limit(30);
    const swap = p.language ? ACCENT_SWAP[p.language] : undefined;
    return lignes
      .map((l) => ({
        style: l.style,
        prompt: swap ? String(l.prompt).split(QC_ACCENT).join(swap).trim() : String(l.prompt).trim(),
      }))
      .filter((x) => x.style && x.prompt);
  } catch {
    return [];
  }
}
