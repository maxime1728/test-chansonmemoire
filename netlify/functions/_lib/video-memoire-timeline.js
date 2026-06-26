// netlify/functions/_lib/video-memoire-timeline.js
//
// Construit le RenderScript CREATOMATE pour la VIDÉO MÉMOIRE : un diaporama tout en douceur des
// photos du client, porté par la chanson. Pensé pour le deuil/hommage (pas un diaporama générique) :
//   fond plum profond · carte-titre serif (titre + « En mémoire de … ») · photos plein cadre en
//   FONDU ENCHAÎNÉ avec un léger zoom lent (effet « Ken Burns ») · signature discrète en bas.
//
// Durée : réutilise le timing de la chanson (module paroles vivantes) pour caler la fin. Si peu de
// photos, on les BOUCLE pour couvrir toute la durée. Mode démo `clipStart` = même mécanique que les
// paroles vivantes (trim_start audio + portion à partir d'un couplet).

'use strict';

const { cleanLyrics, timeLines } = require('./paroles-vivantes-timeline');

// ── Palette (cohérente avec les paroles vivantes) ─────────────────────────────
const BG    = '#241019';
const CREAM = '#F5F0EA';
const GOLD  = '#C4963A';
const MAUVE = '#E7C9D8';
const FONT_TITLE = 'Playfair Display';
const FONT_BODY  = 'EB Garamond';

// ── Dimensions / temps ────────────────────────────────────────────────────────
const W = 1280, H = 720, FPS = 25;
const INTRO   = 3.4;   // carte-titre d'ouverture
const OUTRO   = 5;     // carte-titre de fin
const FADE    = 1.0;   // fondu (in/out) = durée du chevauchement entre photos
const PHOTO_MIN = 4.0, PHOTO_MAX = 7.5;   // durée d'affichage d'une photo (hors chevauchement)

function capFirst(s) { s = String(s || '').trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function sentenceCase(s, keep) {
  let t = String(s || '').trim();
  if (!t) return t;
  t = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  const k = String(keep || '').trim();
  if (k) { const re = new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'); t = t.replace(re, capFirst(k)); }
  return t;
}

function textEl({ text, track, time, duration, family, weight, color, size, y, fadeOut }) {
  const el = {
    type: 'text', track, time, duration, text,
    font_family: family, font_weight: weight || '400', font_size: size,
    fill_color: color, line_height: '128%', width: '86%', x_alignment: '50%', y_alignment: '50%',
    animations: [{ time: 0, duration: FADE, easing: 'quadratic-out', type: 'fade' }]
  };
  if (y != null) el.y = y;
  if (fadeOut) el.animations.push({ time: 'end', duration: FADE, easing: 'quadratic-in', type: 'fade', reversed: true });
  return el;
}

// photos = liste d'URLs (Cloudinary). alignedWords/lyrics servent à connaître la durée de la chanson.
function buildVideoMemoire({ titre, prenom, cadeau, photos, lyrics, alignedWords, audioUrl, clipStart = 0 }) {
  const list = (Array.isArray(photos) ? photos : []).filter(u => typeof u === 'string' && /^https:\/\//.test(u));
  if (!list.length) return null;

  // Durée de la chanson via le timing (réutilise le calcul des paroles vivantes).
  const t = timeLines(cleanLyrics(lyrics), alignedWords);
  let songEnd = t.songEnd;
  let audioStartAt = 0, audioTrimStart = 0;
  if (clipStart > 0) {
    audioTrimStart = clipStart;
    audioStartAt   = INTRO;                               // l'audio démarre après la carte-titre
    songEnd        = +(INTRO + (t.songEnd - clipStart)).toFixed(3);
  }

  // Fenêtre du diaporama : entre la carte-titre d'ouverture et la carte-titre de fin.
  const showStart = INTRO;
  const showEnd   = +Math.max(showStart + PHOTO_MIN, songEnd - OUTRO).toFixed(3);
  const span      = showEnd - showStart;

  // Durée par photo (bornée) ; on BOUCLE si peu de photos pour remplir toute la chanson.
  let per = Math.min(Math.max(span / list.length, PHOTO_MIN), PHOTO_MAX);
  const slots = Math.max(list.length, Math.round(span / per));
  per = span / slots;

  const elements = [];

  // Bande-son (piste 1).
  if (audioUrl) {
    const a = { type: 'audio', track: 1, time: audioStartAt, duration: +(songEnd - audioStartAt).toFixed(3),
                source: audioUrl, loop: false, audio_fade_out: 2.5 };
    if (clipStart > 0) { a.trim_start = audioTrimStart; a.audio_fade_in = 0.8; }
    elements.push(a);
  }

  // Photos (pistes 3 & 4 alternées = fondu enchaîné) + léger zoom lent alterné (Ken Burns).
  for (let i = 0; i < slots; i++) {
    const url  = list[i % list.length];
    const time = +(showStart + i * per).toFixed(3);
    const dur  = +(per + FADE).toFixed(3);               // chevauchement = FADE -> fondu enchaîné
    elements.push({
      type: 'image', track: 3 + (i % 2), time, duration: dur, source: url,
      width: '100%', height: '100%', fit: 'cover', x_alignment: '50%', y_alignment: '50%',
      animations: [
        { time: 0,     duration: FADE, easing: 'quadratic-out', type: 'fade' },
        { time: 'end', duration: FADE, easing: 'quadratic-in',  type: 'fade', reversed: true }
      ]
    });
  }

  // Signature permanente (piste 6, bas).
  elements.push(textEl({ text: 'Chanson Mémoire', track: 6, time: 0, duration: songEnd,
    family: FONT_TITLE, weight: '700', color: CREAM, size: 22, y: '92%' }));

  // Cartes titre (pistes 7 & 8, AU-DESSUS des photos) : ouverture (titre + dédicace) puis fin.
  const titreAff  = sentenceCase(titre || 'Pour toujours', prenom);
  const prenomAff = capFirst(prenom);
  elements.push(textEl({ text: titreAff, track: 7, time: 0, duration: INTRO,
    family: FONT_TITLE, weight: '700', color: MAUVE, size: 64, y: '42%', fadeOut: true }));
  if (prenomAff) {
    elements.push(textEl({ text: (cadeau ? 'Pour ' : 'En mémoire de ') + prenomAff, track: 8, time: 0, duration: INTRO,
      family: FONT_BODY, weight: '400', color: GOLD, size: 30, y: '56%', fadeOut: true }));
  }
  elements.push(textEl({ text: titreAff, track: 7, time: +Math.max(0, songEnd - OUTRO).toFixed(3), duration: OUTRO,
    family: FONT_TITLE, weight: '700', color: MAUVE, size: 56, y: '50%', fadeOut: true }));

  return { output_format: 'mp4', width: W, height: H, frame_rate: FPS, fill_color: BG, elements };
}

module.exports = { buildVideoMemoire, W, H, FPS };
