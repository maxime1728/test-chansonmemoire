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
const W = 1280, H = 720, FPS = 25;   // 25 fps (réf. tarif Creatomate) = ~17% de crédits en moins vs 30, fluidité préservée

// ── Réglages temporels (secondes) ─────────────────────────────────────────────
const INTRO_MIN = 3.5;   // durée minimale de la carte-titre, même si la voix entre tôt
const OUTRO     = 5;     // carte-titre de fin après la dernière ligne chantée
const MIN_LEN   = 1.4;   // durée mini d'affichage d'une ligne (lisibilité)
const PER_LINE  = 3.4;   // cadence de repli quand l'horodatage manque
const FADE      = 0.8;   // durée des fondus

// Effet du surlignage karaoké : 'karaoke' (le doré REMPLIT le mot progressivement, balayage) ou
// 'highlight' (le mot BASCULE au doré d'un coup quand il est chanté). Un seul réglage à changer.
const KARAOKE_EFFECT = 'karaoke';

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

// Majuscule initiale seulement (le reste inchangé) — pour un prénom.
function capFirst(s) {
  s = String(s || '').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// « Casse phrase » FR : 1re lettre majuscule, reste minuscule, mais on REPROTÈGE le prénom du défunt
// s'il apparaît dans le titre (ex. « POUR TOUJOURS MICHEL » -> « Pour toujours Michel »).
function sentenceCase(s, keep) {
  let t = String(s || '').trim();
  if (!t) return t;
  t = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  const k = String(keep || '').trim();
  if (k) {
    const re = new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
    t = t.replace(re, capFirst(k));
  }
  return t;
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
function buildEdit({ titre, prenom, cadeau, transcriptWords, introLen, lyricsEnd, songEnd, audioUrl, clipStart = 0 }) {
  const elements = [];

  // Bande-son (piste 1) : la chanson, bornée à la durée vidéo, fondu de sortie. En mode DÉMO
  // (clipStart>0), on démarre l'audio au couplet voulu via trim_start (Creatomate coupe la source,
  // donc aucune re-signature d'URL Cloudinary) et on l'aligne juste après la courte carte-titre.
  if (audioUrl) {
    const a = { type: 'audio', track: 1,
                time: clipStart > 0 ? introLen : 0,
                duration: +(songEnd - (clipStart > 0 ? introLen : 0)).toFixed(3),
                source: audioUrl, loop: false, audio_fade_out: 2 };
    if (clipStart > 0) { a.trim_start = clipStart; a.audio_fade_in = 0.8; }
    elements.push(a);
  }

  // Signature permanente (piste 2, bas) — peinte avant les paroles -> jamais par-dessus.
  elements.push(textEl({
    text: 'Chanson Mémoire', track: 2, time: 0, duration: songEnd,
    family: FONT_TITLE, weight: '700', color: CREAM, size: 22, y: '92%'
  }));

  // Cartes titre (piste 3) : intro (titre + « En mémoire de … ») puis fin. Titre en casse phrase
  // (majuscule au début), dédicace avec « En mémoire de » / « Pour » + prénom capitalisé.
  const titreAff  = sentenceCase(titre || 'Pour toujours', prenom);
  const prenomAff = capFirst(prenom);
  if (introLen > 0.8) {
    elements.push(textEl({
      text: titreAff, track: 3, time: 0, duration: introLen,
      family: FONT_TITLE, weight: '700', color: MAUVE, size: 64, y: '44%', fadeOut: true
    }));
    if (prenomAff) {
      elements.push(textEl({
        text: (cadeau ? 'Pour ' : 'En mémoire de ') + prenomAff, track: 3, time: 0, duration: introLen,
        family: FONT_BODY, weight: '400', color: GOLD, size: 30, y: '58%', fadeOut: true
      }));
    }
  }
  elements.push(textEl({
    text: titreAff, track: 3, time: Math.max(0, lyricsEnd), duration: OUTRO,
    family: FONT_TITLE, weight: '700', color: MAUVE, size: 56, y: '50%', fadeOut: true
  }));

  // Paroles KARAOKÉ (piste 4) : TES paroles exactes + le timing Suno (transcript_source), rendues
  // par le moteur natif de Creatomate -> surlignage DORÉ qui balaie les mots de gauche à droite, au
  // fil de la voix. Le retour à la ligne et le centrage sont gérés automatiquement par le moteur.
  if (transcriptWords && transcriptWords.length) {
    elements.push({
      type: 'text', track: 4, time: 0, duration: songEnd,
      transcript_source: transcriptWords,    // [{ time, duration, value }] -> nos mots horodatés (s)
      transcript_effect: KARAOKE_EFFECT,      // 'karaoke' ou 'highlight' (constante en tête de fichier)
      transcript_split: 'word',
      transcript_color: GOLD,                 // couleur du surlignage (mot en train d'être chanté)
      transcript_maximum_length: 42,          // ~1 ligne de paroles par segment affiché
      font_family: FONT_BODY, font_weight: '400', font_size: 48,
      fill_color: CREAM, line_height: '136%',
      width: '82%', x_alignment: '50%', y_alignment: '50%'
    });
  }

  return { output_format: 'mp4', width: W, height: H, frame_rate: FPS, fill_color: BG, elements };
}

// Transforme l'alignement Suno (ou un repli cadencé) en transcript_source Creatomate :
// un tableau [{ time, duration, value }] en SECONDES, un objet par mot, dans l'ordre.
// Retire les balises de structure ([Intro], [Verse], [Chorus]…) que Suno COLLE au mot, et aplatit
// les retours à la ligne -> on récupère le VRAI mot, propre (le texte horodaté Suno = nos paroles).
function cleanWord(w) {
  return String(w || '')
    .replace(/\[[^\]]*\]/g, ' ')   // balises entre crochets
    .replace(/\s+/g, ' ')          // \n et espaces multiples -> une espace
    .trim();
}

// Aligne les VRAIS mots (le texte = source de vérité) sur les timings Suno. Comme Suno aligne déjà le
// texte fourni, les deux séquences sont quasi identiques : on GARDE le mot du texte (ça corrige les
// coquilles de Suno) avec le timing Suno. Les petits décalages (un mot en trop d'un côté) sont
// rattrapés par une fenêtre de resynchronisation.
function alignToRealText(realWords, suno) {
  const norm = s => String(s).toLowerCase()
    .replace(/[.,!?;:«»"()…]/g, '').replace(/[’'`]/g, "'").trim();
  const out = [];
  const N = realWords.length, M = suno.length, WIN = 6;
  let i = 0, j = 0;
  while (i < N && j < M) {
    if (norm(realWords[i]) === norm(suno[j].value)) {
      out.push({ time: suno[j].time, duration: suno[j].duration, value: realWords[i] });
      i++; j++; continue;
    }
    let fj = -1;   // realWords[i] retrouvé plus loin côté Suno -> Suno a inséré des mots
    for (let k = j + 1; k < Math.min(M, j + 1 + WIN); k++) {
      if (norm(suno[k].value) === norm(realWords[i])) { fj = k; break; }
    }
    let fi = -1;   // suno[j] retrouvé plus loin côté texte -> le texte a des mots sans audio
    for (let k = i + 1; k < Math.min(N, i + 1 + WIN); k++) {
      if (norm(realWords[k]) === norm(suno[j].value)) { fi = k; break; }
    }
    if (fj !== -1 && (fi === -1 || (fj - j) <= (fi - i))) {
      j = fj;                                    // saute les mots Suno en trop (ad-libs)
    } else if (fi !== -1) {                       // interpole les vrais mots intermédiaires
      const tEnd = suno[j].time;
      const tStart = out.length ? out[out.length - 1].time + out[out.length - 1].duration
                                : Math.max(0, tEnd - 0.3 * (fi - i));
      const step = Math.max(0.05, (tEnd - tStart) / (fi - i + 1));
      for (let k = i; k < fi; k++) {
        out.push({ time: +(tStart + (k - i) * step).toFixed(3), duration: +(step * 0.9).toFixed(3), value: realWords[k] });
      }
      i = fi;
    } else {                                      // substitution : on garde le vrai mot + timing courant
      out.push({ time: suno[j].time, duration: suno[j].duration, value: realWords[i] });
      i++; j++;
    }
  }
  while (i < N) {                                 // vrais mots restants en fin -> on enchaîne
    const prev = out.length ? out[out.length - 1] : { time: 0, duration: 0.4 };
    out.push({ time: +(prev.time + prev.duration).toFixed(3), duration: 0.4, value: realWords[i] });
    i++;
  }
  return out;
}

function buildTranscript(realWords, lines, alignedWords) {
  const suno = (Array.isArray(alignedWords) ? alignedWords : [])
    .filter(w => w && Number.isFinite(w.startS) && Number.isFinite(w.endS) && w.endS >= w.startS)
    .map(w => ({
      value: cleanWord(w.word),
      time: +Number(w.startS).toFixed(3),
      duration: +Math.max(0.08, w.endS - w.startS).toFixed(3)
    }))
    .filter(w => w.value);

  if (suno.length >= 6 && realWords && realWords.length) return alignToRealText(realWords, suno);

  // Repli (pas d'horodatage Suno) : on répartit les vrais mots sur la cadence des lignes.
  const out = [];
  lines.forEach(l => {
    const ws = String(l.text).split(/\s+/).filter(Boolean);
    const step = l.length / Math.max(1, ws.length);
    ws.forEach((w, i) => out.push({
      time: +(l.start + i * step).toFixed(3),
      duration: +Math.max(0.2, step * 0.9).toFixed(3),
      value: w
    }));
  });
  return out;
}

// Façade : paroles brutes + alignement Suno -> RenderScript Creatomate prêt à rendre.
function buildEditFromLyrics({ titre, prenom, cadeau, lyrics, alignedWords, audioUrl, clipStart = 0 }) {
  const displayLines = cleanLyrics(lyrics);
  if (displayLines.length === 0) return null;
  const realWords = displayLines.join(' ').split(/\s+/).filter(Boolean);   // VRAIS mots (texte = vérité)
  const t = timeLines(displayLines, alignedWords);
  let transcriptWords = buildTranscript(realWords, t.lines, alignedWords);
  let introLen = t.introLen, lyricsEnd = t.lyricsEnd, songEnd = t.songEnd;

  // Mode DÉMO : ne garder que les paroles à partir de clipStart (s), recalées juste après une
  // courte carte-titre. L'audio est trimé d'autant dans buildEdit -> tout reste synchronisé.
  if (clipStart > 0) {
    const INTRO_DEMO = 2.6;
    transcriptWords = transcriptWords
      .filter(w => w.time >= clipStart - 0.05)
      .map(w => ({ time: +(w.time - clipStart + INTRO_DEMO).toFixed(3), duration: w.duration, value: w.value }));
    introLen = INTRO_DEMO;
    const last = transcriptWords[transcriptWords.length - 1];
    lyricsEnd = +((last ? last.time + last.duration : INTRO_DEMO)).toFixed(3);
    songEnd = +(lyricsEnd + OUTRO).toFixed(3);
  }

  return buildEdit({ titre, prenom, cadeau, audioUrl, clipStart, transcriptWords, introLen, lyricsEnd, songEnd });
}

module.exports = { cleanLyrics, cleanWord, timeLines, alignToRealText, buildTranscript, buildEdit, buildEditFromLyrics, FONT_TITLE, FONT_BODY };
