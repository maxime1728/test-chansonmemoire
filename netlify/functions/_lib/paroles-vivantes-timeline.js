// netlify/functions/_lib/paroles-vivantes-timeline.js
//
// Construit l'« edit » Shotstack pour la vidéo PAROLES VIVANTES (fondu doux ligne par ligne).
// Module PARTAGÉ entre lancer-paroles-vivantes.js (production) et tools/rendu-test.js (sandbox) :
// une seule source de vérité pour le design -> aucune divergence entre le rendu test et le rendu livré.
//
// Design (palette = celle du PDF cadeau, inversée pour la vidéo) :
//   fond plum profond · titre serif Playfair mauve clair · « en mémoire de … » doré ·
//   paroles serif EB Garamond crème qui apparaissent en fondu, une « page » à la fois ·
//   signature « Chanson Mémoire » discrète en bas pendant toute la durée.
//
// Synchronisation : on utilise les paroles HORODATÉES de Suno (startS/endS par mot) pour caler
//   chaque ligne sur la voix. Si l'alignement manque, on retombe sur une cadence douce et fixe.

'use strict';

// ── Palette ─────────────────────────────────────────────────────────────────
const BG    = '#241019';   // plum profond (famille du #2E1A28 du PDF)
const CREAM = '#F5F0EA';   // crème — corps des paroles
const GOLD  = '#C4963A';   // doré — accent « en mémoire de »
const MAUVE = '#E7C9D8';   // mauve clair, lisible sur fond sombre — titre

// ── Polices serif (Fontsource via jsDelivr : URLs TTF directes, stables, accents FR garantis) ──
const FONTS = [
  { src: 'https://cdn.jsdelivr.net/fontsource/fonts/playfair-display@latest/latin-700-normal.ttf' },
  { src: 'https://cdn.jsdelivr.net/fontsource/fonts/eb-garamond@latest/latin-400-normal.ttf' }
];
const FONT_TITLE = 'Playfair Display';
const FONT_BODY  = 'EB Garamond';

// ── Réglages temporels (secondes) ─────────────────────────────────────────────
const INTRO_MIN = 3.5;   // durée minimale de la carte-titre, même si la voix entre tôt
const OUTRO     = 5;     // carte-titre de fin après la dernière ligne chantée
const MIN_LEN   = 1.4;   // durée mini d'affichage d'une ligne (lisibilité)
const PER_LINE  = 3.4;   // cadence de repli quand l'horodatage manque

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

// Calcule pour chaque ligne { text, start, length } + introLen + songEnd.
// alignedWords = tableau Suno [{ word, startS, endS, success }] (peut être vide -> repli).
function timeLines(displayLines, alignedWords) {
  const words = (Array.isArray(alignedWords) ? alignedWords : [])
    .filter(w => w && Number.isFinite(w.startS) && Number.isFinite(w.endS) && w.endS >= w.startS);

  const totalW = displayLines.reduce((a, l) => a + Math.max(1, countWords(l)), 0);
  // Assez d'alignement pour caler sur la voix ? (sinon cadence fixe)
  const aligned = words.length >= Math.max(6, Math.ceil(totalW * 0.5));

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

  // Durées « gapless » : chaque ligne reste à l'écran jusqu'à l'apparition de la suivante
  // (lecture calme, pas de noir entre les lignes).
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

// Assemble l'« edit » Shotstack complet à partir des lignes timées.
function buildEdit({ titre, prenom, lines, introLen, lyricsEnd, songEnd, audioUrl, resolution }) {
  // Piste 0 (au-dessus) : les paroles, ligne par ligne, en fondu.
  const lyricClips = lines.map(l => ({
    asset: {
      type: 'text', text: l.text,
      font: { family: FONT_BODY, color: CREAM, size: 44, lineHeight: 1.35 },
      alignment: { horizontal: 'center', vertical: 'center' },
      width: 1000, height: 460
    },
    start: l.start, length: l.length, position: 'center',
    transition: { in: 'fade', out: 'fade' }
  }));

  // Piste 1 : carte-titre d'intro (titre + « en mémoire de … ») puis carte de fin.
  const cardClips = [];
  if (introLen > 0.8) {
    cardClips.push({
      asset: {
        type: 'text', text: titre || 'Pour toujours',
        font: { family: FONT_TITLE, color: MAUVE, size: 66, lineHeight: 1.15 },
        alignment: { horizontal: 'center', vertical: 'center' }, width: 1080, height: 240
      },
      start: 0, length: introLen, position: 'center', offset: { x: 0, y: 0.06 },
      transition: { in: 'fade', out: 'fade' }
    });
    if (prenom) {
      cardClips.push({
        asset: {
          type: 'text', text: 'en mémoire de ' + prenom,
          font: { family: FONT_BODY, color: GOLD, size: 30, lineHeight: 1.2 },
          alignment: { horizontal: 'center', vertical: 'center' }, width: 900, height: 120
        },
        start: 0, length: introLen, position: 'center', offset: { x: 0, y: -0.12 },
        transition: { in: 'fade', out: 'fade' }
      });
    }
  }
  cardClips.push({
    asset: {
      type: 'text', text: titre || 'Pour toujours',
      font: { family: FONT_TITLE, color: MAUVE, size: 58, lineHeight: 1.15 },
      alignment: { horizontal: 'center', vertical: 'center' }, width: 1080, height: 240
    },
    start: Math.max(0, lyricsEnd), length: OUTRO, position: 'center',
    transition: { in: 'fade', out: 'fade' }
  });

  // Piste 2 : signature permanente, en bas.
  const footerClip = {
    asset: {
      type: 'text', text: 'Chanson Mémoire',
      font: { family: FONT_TITLE, color: CREAM, size: 24, opacity: 0.55, lineHeight: 1 },
      alignment: { horizontal: 'center', vertical: 'center' }, width: 600, height: 70
    },
    start: 0, length: songEnd, position: 'bottom', offset: { x: 0, y: 0.06 },
    transition: { in: 'fade' }
  };

  const timeline = {
    background: BG,
    fonts: FONTS,
    tracks: [
      { clips: lyricClips },
      { clips: cardClips },
      { clips: [footerClip] }
    ]
  };
  if (audioUrl) timeline.soundtrack = { src: audioUrl, effect: 'fadeOut' };

  return { timeline, output: { format: 'mp4', resolution: resolution || 'hd' } };
}

// Façade : paroles brutes + alignement Suno -> « edit » Shotstack prêt à rendre.
function buildEditFromLyrics({ titre, prenom, lyrics, alignedWords, audioUrl, resolution }) {
  const displayLines = cleanLyrics(lyrics);
  if (displayLines.length === 0) return null;
  const t = timeLines(displayLines, alignedWords);
  return buildEdit({
    titre, prenom, audioUrl, resolution,
    lines: t.lines, introLen: t.introLen, lyricsEnd: t.lyricsEnd, songEnd: t.songEnd
  });
}

module.exports = { cleanLyrics, timeLines, buildEdit, buildEditFromLyrics, FONTS, FONT_TITLE, FONT_BODY };
