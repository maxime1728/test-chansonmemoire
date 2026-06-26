// netlify/functions/_lib/video-memoire-timeline.js
//
// RenderScript CREATOMATE de la VIDÉO MÉMOIRE (diaporama des photos du client porté par la chanson).
// Pensé pour le deuil/hommage. TROIS styles (param `style`) :
//   'fullscreen' : photos plein cadre, fondu enchaîné, zoom/pano lent (Ken Burns).
//   'framed'     : photo NETTE cadrée (coins doux + ombre) flottant sur un fond = la même photo
//                  FLOUTÉE et assombrie (transformation Cloudinary) -> ambiance « tribute studio ».
//   'mix'        : alterne plein cadre et cadré.
// Carte d'ouverture : titre + « En mémoire de … » + dates (naissance–décès) + citation.
// Durée : calée sur la chanson (timing paroles) ; `maxDuration` borne (ex. 60 s pour un aperçu).
// `clipStart` (s) = démo : démarre à un couplet (trim_start audio).

'use strict';

const { cleanLyrics, timeLines } = require('./paroles-vivantes-timeline');

const BG    = '#241019', CREAM = '#F5F0EA', GOLD = '#C4963A', MAUVE = '#E7C9D8';
const FONT_TITLE = 'Playfair Display', FONT_BODY = 'EB Garamond';
const W = 1280, H = 720, FPS = 25;
const INTRO = 4.0, OUTRO = 5, FADE = 1.0;
const PHOTO_MIN = 3.6, PHOTO_MAX = 9.0;   // durée d'affichage d'une photo (hors chevauchement) — s'adapte au nb de photos

function capFirst(s) { s = String(s || '').trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function sentenceCase(s, keep) {
  let t = String(s || '').trim(); if (!t) return t;
  t = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  const k = String(keep || '').trim();
  if (k) { const re = new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'); t = t.replace(re, capFirst(k)); }
  return t;
}
function textEl({ text, track, time, duration, family, weight, color, size, y, fadeOut }) {
  const el = { type: 'text', track, time, duration, text, font_family: family, font_weight: weight || '400',
    font_size: size, fill_color: color, line_height: '128%', width: '86%', x_alignment: '50%', y_alignment: '50%',
    animations: [{ time: 0, duration: FADE, easing: 'quadratic-out', type: 'fade' }] };
  if (y != null) el.y = y;
  if (fadeOut) el.animations.push({ time: 'end', duration: FADE, easing: 'quadratic-in', type: 'fade', reversed: true });
  return el;
}

// Fond = la photo FLOUTÉE + assombrie, plein cadre, via transformation Cloudinary (pas d'asset externe).
function blurredBg(url) {
  return url.replace('/upload/', '/upload/c_fill,w_1280,h_720,e_blur:2000,e_brightness:-28/');
}
// Ken Burns : animation Scale (zoom lent) + point d'ancrage alterné -> sensation de glissement/pano.
function kenBurns(dur, i) {
  const A = [['28%','32%'], ['72%','34%'], ['32%','70%'], ['68%','66%'], ['50%','25%'], ['46%','74%']];
  const a = A[i % A.length];
  return { time: 0, duration: dur, easing: 'linear', type: 'scale', start_scale: '104%', end_scale: '120%', x_anchor: a[0], y_anchor: a[1] };
}
function fadeInOut() {
  return [
    { time: 0, duration: FADE, easing: 'quadratic-out', type: 'fade' },
    { time: 'end', duration: FADE, easing: 'quadratic-in', type: 'fade', reversed: true }
  ];
}

function buildVideoMemoire({ titre, prenom, cadeau, photos, lyrics, alignedWords, audioUrl,
                             clipStart = 0, style = 'fullscreen', maxDuration = 0, naissance = '', deces = '', citation = '' }) {
  const list = (Array.isArray(photos) ? photos : []).filter(u => typeof u === 'string' && /^https:\/\//.test(u));
  if (!list.length) return null;

  const t = timeLines(cleanLyrics(lyrics), alignedWords);
  let songEnd = t.songEnd, audioStartAt = 0, audioTrimStart = 0;
  if (clipStart > 0) { audioTrimStart = clipStart; audioStartAt = INTRO; songEnd = +(INTRO + (t.songEnd - clipStart)).toFixed(3); }
  if (maxDuration > 0) songEnd = Math.min(songEnd, +(INTRO + maxDuration).toFixed(3));

  const showStart = INTRO;
  const showEnd   = +Math.max(showStart + PHOTO_MIN, songEnd - OUTRO).toFixed(3);
  const span      = showEnd - showStart;
  let per = Math.min(Math.max(span / list.length, PHOTO_MIN), PHOTO_MAX);
  const slots = Math.max(1, Math.round(span / per));
  per = span / slots;

  const elements = [];

  // Bande-son (piste 1).
  if (audioUrl) {
    const a = { type: 'audio', track: 1, time: audioStartAt, duration: +(songEnd - audioStartAt).toFixed(3),
                source: audioUrl, loop: false, audio_fade_out: 2.5 };
    if (clipStart > 0) { a.trim_start = audioTrimStart; a.audio_fade_in = 0.8; }
    elements.push(a);
  }

  // Photos. Pistes : 2 = fond flou (mode cadré) ; 3 & 4 = photos alternées (fondu enchaîné).
  for (let i = 0; i < slots; i++) {
    const url  = list[i % list.length];
    const time = +(showStart + i * per).toFixed(3);
    const dur  = +(per + FADE).toFixed(3);
    const framed = style === 'framed' || (style === 'mix' && i % 2 === 1);
    const fgTrack = 3 + (i % 2);

    if (framed) {
      elements.push({ type: 'image', track: 2, time, duration: dur, source: blurredBg(url),
        width: '100%', height: '100%', fit: 'cover', animations: fadeInOut() });
      elements.push({ type: 'image', track: fgTrack, time, duration: dur, source: url,
        width: '74%', height: '74%', fit: 'cover', x_alignment: '50%', y_alignment: '47%',
        border_radius: '1.5 vmin', shadow_color: 'rgba(0,0,0,0.55)', shadow_blur: '4 vmin', shadow_y: '1 vmin',
        animations: [kenBurns(dur, i), ...fadeInOut()] });
    } else {
      elements.push({ type: 'image', track: fgTrack, time, duration: dur, source: url,
        width: '100%', height: '100%', fit: 'cover', x_alignment: '50%', y_alignment: '50%',
        animations: [kenBurns(dur, i), ...fadeInOut()] });
    }
  }

  // Signature permanente (piste 6, bas).
  elements.push(textEl({ text: 'Chanson Mémoire', track: 6, time: 0, duration: songEnd,
    family: FONT_TITLE, weight: '700', color: CREAM, size: 22, y: '93%' }));

  // Cartes titre (pistes 7-9, AU-DESSUS) : ouverture (titre + dédicace + dates + citation) puis fin.
  const titreAff  = sentenceCase(titre || 'Pour toujours', prenom);
  const prenomAff = capFirst(prenom);
  const datesStr  = (naissance && deces) ? (String(naissance).trim() + ' – ' + String(deces).trim())
                                         : String(naissance || deces || '').trim();
  const dedicace  = (cadeau ? 'Pour ' : 'En mémoire de ') + prenomAff + (datesStr ? '  ·  ' + datesStr : '');
  elements.push(textEl({ text: titreAff, track: 7, time: 0, duration: INTRO,
    family: FONT_TITLE, weight: '700', color: MAUVE, size: 62, y: '38%', fadeOut: true }));
  if (prenomAff) elements.push(textEl({ text: dedicace, track: 8, time: 0, duration: INTRO,
    family: FONT_BODY, weight: '400', color: GOLD, size: 28, y: '52%', fadeOut: true }));
  if (citation) elements.push(textEl({ text: '« ' + String(citation).trim() + ' »', track: 9, time: 0, duration: INTRO,
    family: FONT_BODY, weight: '400', color: CREAM, size: 24, y: '63%', fadeOut: true }));
  elements.push(textEl({ text: titreAff, track: 7, time: +Math.max(0, songEnd - OUTRO).toFixed(3), duration: OUTRO,
    family: FONT_TITLE, weight: '700', color: MAUVE, size: 54, y: '50%', fadeOut: true }));

  return { output_format: 'mp4', width: W, height: H, frame_rate: FPS, fill_color: BG, elements };
}

module.exports = { buildVideoMemoire, W, H, FPS };
