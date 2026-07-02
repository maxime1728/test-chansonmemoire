// _lib/anthropic.ts — appel Anthropic + parsing de la réponse paroles.
//
// PORTAGE FIDÈLE de generate-lyrics.js (callAnthropic, parseModel, normSuggestions) :
// même modèle, mêmes retries bornés, même parseur TOLÉRANT (le repli manuel est la
// parade à la cause intermittente n°1 des paroles manquantes : des sauts de ligne
// BRUTS dans la valeur JSON "lyrics"). Testé par tests-ts/prompts-paroles.test.ts.
//
// Règle observabilité : retries BORNÉS (3 tentatives, backoff 1 s puis 2 s), jamais
// de retry infini. L'appelant journalise l'échec final (P1/P2 selon le contexte).

export const MODELE_PAROLES = 'claude-sonnet-4-6';

// Erreurs Anthropic TRANSITOIRES (surcharge/limite/coupure) : ces échecs reviennent
// vite, donc 3 tentatives + court backoff. 4xx « client » = pas de réessai.
const ANTHROPIC_RETRYABLE = new Set([429, 500, 502, 503, 529]);

export interface ReponseAnthropic {
  ok: boolean;
  status: number;
  data: unknown;
}

export async function callAnthropic(
  systemPrompt: string,
  userPrompt: string,
  apiKey: string,
): Promise<ReponseAnthropic> {
  const ATTEMPTS = 3;
  let last: ReponseAnthropic = { ok: false, status: 0, data: null };
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODELE_PAROLES,
          max_tokens: 2500,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });
      const data: unknown = await res.json().catch(() => ({}));
      if (res.ok || !ANTHROPIC_RETRYABLE.has(res.status)) return { ok: res.ok, status: res.status, data };
      last = { ok: false, status: res.status, data }; // transitoire -> on réessaie
    } catch (e) {
      last = { ok: false, status: 0, data: { error: e instanceof Error ? e.message : String(e) } }; // coupure réseau -> on réessaie
    }
    if (i < ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1))); // backoff 1s puis 2s
  }
  return last;
}

export interface ParolesGenerees {
  title?: string;
  lyrics?: string;
  suggestions?: unknown;
  error?: string;
}

// Parse la réponse du modèle. Copie fidèle du parseModel legacy (repli tolérant
// aux sauts de ligne bruts inclus, verrouillé par tests/generate-lyrics.test.js).
export function parseModel(data: unknown): ParolesGenerees | null {
  const blocs = ((data as { content?: Array<{ type?: string; text?: string }> })?.content) || [];
  const raw = blocs
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
  let clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const debut = clean.indexOf('{');
  const fin = clean.lastIndexOf('}');
  if (debut !== -1 && fin !== -1 && fin > debut) clean = clean.slice(debut, fin + 1);
  try {
    return JSON.parse(clean) as ParolesGenerees;
  } catch {
    // repli ci-dessous
  }

  // REPLI TOLÉRANT : le prompt demande de « vrais sauts de ligne » dans "lyrics" ->
  // le modèle met parfois des newlines BRUTS dans la valeur JSON (= JSON invalide).
  // On extrait alors les champs à la main.
  try {
    const titleM = clean.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const lyricsM = clean.match(/"lyrics"\s*:\s*"([\s\S]*?)"\s*,\s*"suggestions"\s*:/);
    const suggM = clean.match(/"suggestions"\s*:\s*\[([\s\S]*?)\]/);
    if (lyricsM) {
      const unescape = (s: string) =>
        String(s).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      const lyrics = unescape(lyricsM[1] ?? '');
      let suggestions: unknown = [];
      if (suggM) {
        try {
          suggestions = JSON.parse('[' + suggM[1] + ']');
        } catch {
          suggestions = (suggM[1]?.match(/"((?:[^"\\]|\\.)*)"/g) || []).map((s) => unescape(s.slice(1, -1)));
        }
      }
      if (lyrics.trim()) return { title: titleM ? unescape(titleM[1] ?? '') : '', lyrics, suggestions };
    }
    if (/"error"\s*:\s*"invalid_input"/.test(clean)) return { error: 'invalid_input' };
  } catch {
    // dernier repli : réponse inexploitable -> null, l'appelant décide (422/retour recue)
  }
  return null;
}

export function normSuggestions(s: unknown): string[] {
  if (!Array.isArray(s)) return [];
  return s.filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, 3);
}
