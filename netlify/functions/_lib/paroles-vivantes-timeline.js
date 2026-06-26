// netlify/functions/_lib/paroles-vivantes-timeline.js
//
// Construit le RenderScript CREATOMATE pour la vidéo PAROLES VIVANTES (paroles en fondu, mot par mot).
// Module PARTAGÉ entre lancer-paroles-vivantes.js (production) et tools/rendu-test.js (sandbox) :
// une seule source de vérité pour le design -> aucune divergence entre le rendu test et le rendu livré.
//
// Design (palette = celle du PDF cadeau, inversée pour la vidéo) :
//   fond plum profond · titre serif Playfair mauve clair · « en mémoire de … » doré ·
//   paroles serif EB Garamond crème qui apparaissent en fondu, une « page » à la fois ·
//   signature « Chanson Mémoire » discrète en bas pendant toute la durée.
//
// Polices : Google Fonts par NOM (Creatomate les fournit) -> rien à héberger.
// Synchronisation : paroles HORODATÉES Suno (startS/endS par mot). Sans alignement -> cadence douce.

'use strict';

// ── Palette ─────────────────────────────────────────────────────────────────
const BG    = '#241019';   // plum profond (famille du #2E1A28 du PDF)
const CREAM = '#F5F0EA';   // crème — corps des paroles
const GOLD  = '#C4963A';   // doré — accent « en mémoire de »
const MAUVE = '#E7C9D8';   // mauve clair, lisible sur fond sombre — titre

const FONT_TITLE = 'Playfair Display';   // Google Font (serif élégant)
const FONT_BODY  = 'EB Garamond';        // Google Font (serif lisible)

// ── Dimensions ────────────────────────────────────────────────────────────────
const W = 1280, H = 720, FPS = 30;

// ── Réglages temporels (secondes) ─────────────────────────────────────────────
const INTRO_MIN = 3.5;   // durée minimale de la carte-titre, même si la voix entre tôt
const OUTRO     = 5;     // carte-titre de fin après la dernière ligne chantée
const MIN_LEN   = 1.4;   // durée mini d'affichage d'une ligne (lisibilité)
const PER_LINE  = 3.4;   // cadence de repli quand l'horodatage manque
const FADE      = 0.8;   // durée des fondus

// Retire les balises de structure ([Refrain], (x2)…) et les lignes vides -> lignes à AFFICHER.
function cleanLyrics(lyrics) {
  return String(lyrics || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => !/^[\[(].*[\])]$/.test(s));   // [Verse 1], [Chorus], (x2)…
}

function countWords(line) {
  return (String(line).match(/\S+/g) || []).length;
}

// Calcule pour chaque ligne { text, start, length } + introLen + lyricsEnd + songEnd.
// alignedWords = tableau Suno [{ word, startS, endS, success }] (peut être vide -> repli).
function timeLines(displayLines, alignedWords) {
  const words = (Array.isArray(alignedWords) ? alignedWords : [])
    .filter(w => w && Number.isFinite(w.startS) && Number.isFinite(w.endS) && w.endS >= w.startS);

  const totalW = displayLines.reduce((a, l) => a + Math.max(1, countWords(l)), 0);
  const aligned = words.length >= Math.max(6, Math.ceil(totalW * 0.5));   // assez pour caler sur la voix ?

  const starts = new Array(displayLines.length);
  let lyricsEnd;

  if (aligned) {
    let cur = 0, prevEnd = 0;
    for (let i = 0; i < displayLines.length; i++) {
      const n = Math.max(1, countWords(displayLines[i]));
      if (cur < words.length) {
        starts[i] = words[Math.min(cur, words.length - 1)].startS;
        cur += n;
        prevEnd = words[Math.min(cur - 1, words.length - 1)].endS;
      } else {
        starts[i] = prevEnd;          // mots épuisés -> on enchaîne calmement
        prevEnd += PER_LINE;
      }
    }
    lyricsEnd = prevEnd;
  } else {
    let t = INTRO_MIN;
    for (let i = 0; i < displayLines.length; i++) { starts[i] = t; t += PER_LINE; }
    lyricsEnd = t;
  }

  // Monotonie stricte (jamais de recul) + intro qui respire.
  for (let i = 1; i < starts.length; i++) {
    if (!(starts[i] > starts[i - 1])) starts[i] = starts[i - 1] + MIN_LEN;
  }
  if (starts.length && starts[0] < INTRO_MIN) {
    const shift = INTRO_MIN - starts[0];
    for (let i = 0; i < starts.length; i++) starts[i] += shift;
    lyricsEnd += shift;
  }
  if (starts.length) lyricsEnd = Math.max(lyricsEnd, starts[starts.length - 1] + MIN_LEN);

  // Durées « gapless » : chaque ligne reste à l'écran jusqu'à l'apparition de la suivante.
  const lines = displayLines.map((text, i) => {
    const start = starts[i];
    const next  = (i + 1 < starts.length) ? starts[i + 1] : lyricsEnd;
    return { text, start: +start.toFixed(3), length: +Math.max(MIN_LEN, next - start).toFixed(3) };
  });

  return {
    lines,
    introLen: +(starts.length ? starts[0] : INTRO_MIN).toFixed(3),
    lyricsEnd: +lyricsEnd.toFixed(3),
    songEnd:  +(lyricsEnd + OUTRO).toFixed(3)
  };
}

// Élément texte Creatomate. fadeOut=true -> ajoute un fondu de sortie (animation inversée en fin).
function textEl({ text, track, time, duration, family, weight, color, size, y, fadeOut }) {
  const el = {
    type: 'text', track, time, duration, text,
    font_family: family, font_weight: weight || '400', font_size: size,
    fill_color: color, line_height: '128%',
    width: '86%', x_alignment: '50%', y_alignment: '50%',
    animations: [{ time: 0, duration: FADE, easing: 'quadratic-out', type: 'fade' }]
  };
  if (y != null) el.y = y;
  if (fadeOut) el.animations.push({ time: 'end', duration: FADE, easing: 'quadratic-in', type: 'fade', reversed: true });
  return el;
}

// Assemble le RenderScript Creatomate complet à partir des lignes timées.
function buildEdit({ titre, prenom, cadeau, lines, introLen, lyricsEnd, songEnd, audioUrl }) {
  const elements = [];

  // Bande-son (piste 1) : la chanson, bornée à la durée vidéo, fondu de sortie.
  if (audioUrl) {
    elements.push({ type: 'audio', track: 1, time: 0, duration: songEnd, source: audioUrl, loop: false, audio_fade_out: 2 });
  }

  // Signature permanente (piste 2, bas) — peinte avant les paroles -> jamais par-dessus.
  elements.push(textEl({
    text: 'Chanson Mémoire', track: 2, time: 0, duration: songEnd,
    family: FONT_TITLE, weight: '700', color: CREAM, size: 22, y: '92%'
  }));

  // Cartes titre (piste 3) : intro (titre + « en mémoire de … ») puis fin.
  if (introLen > 0.8) {
    elements.push(textEl({
      text: titre || 'Pour toujours', track: 3, time: 0, duration: introLen,
      family: FONT_TITLE, weight: '700', color: MAUVE, size: 64, y: '44%', fadeOut: true
    }));
    if (prenom) {
      elements.push(textEl({
        text: (cadeau ? 'pour ' : 'en mémoire de ') + prenom, track: 3, time: 0, duration: introLen,
        family: FONT_BODY, weight: '400', color: GOLD, size: 30, y: '58%', fadeOut: true
      }));
    }
  }
  elements.push(textEl({
    text: titre || 'Pour toujours', track: 3, time: Math.max(0, lyricsEnd), duration: OUTRO,
    family: FONT_TITLE, weight: '700', color: MAUVE, size: 56, y: '50%', fadeOut: true
  }));

  // Paroles (piste 4) : une ligne à la fois, centrée. Les MOTS apparaissent un par un en fondu,
  // au fil du chant (animation par mot, split=word), au lieu d'un bloc d'un coup. La révélation
  // s'étale sur la durée chantée de la ligne. Peintes en dernier (donc au-dessus).
  lines.forEach(l => {
    const reveal = Math.min(Math.max(l.length * 0.7, 0.9), 2.6);   // durée d'apparition des mots
    elements.push({
      type: 'text', track: 4, time: l.start, duration: l.length, text: l.text,
      font_family: FONT_BODY, font_weight: '400', font_size: 46,
      fill_color: CREAM, line_height: '132%',
      width: '84%', x_alignment: '50%', y_alignment: '50%',
      animations: [
        // Apparition MOT PAR MOT (chaque mot fond en entrée, décalé sur la durée de la ligne).
        { time: 0, duration: reveal, easing: 'quadratic-out', type: 'fade', split: 'word', scope: 'split-clip' },
        // Sortie en fondu de la ligne entière à la fin.
        { time: 'end', duration: FADE, easing: 'quadratic-in', type: 'fade', reversed: true }
      ]
    });
  });

  return { output_format: 'mp4', width: W, height: H, frame_rate: FPS, fill_color: BG, elements };
}

// Façade : paroles brutes + alignement Suno -> RenderScript Creatomate prêt à rendre.
function buildEditFromLyrics({ titre, prenom, cadeau, lyrics, alignedWords, audioUrl }) {
  const displayLines = cleanLyrics(lyrics);
  if (displayLines.length === 0) return null;
  const t = timeLines(displayLines, alignedWords);
  return buildEdit({
    titre, prenom, cadeau, audioUrl,
    lines: t.lines, introLen: t.introLen, lyricsEnd: t.lyricsEnd, songEnd: t.songEnd
  });
}

module.exports = { cleanLyrics, timeLines, buildEdit, buildEditFromLyrics, FONT_TITLE, FONT_BODY };
