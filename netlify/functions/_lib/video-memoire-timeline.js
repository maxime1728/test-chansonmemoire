// netlify/functions/_lib/video-memoire-timeline.js
//
// RenderScript CREATOMATE de la VIDÉO MÉMOIRE (diaporama des photos du client porté par la chanson).
// 3 styles (`style`) : 'fullscreen' (plein cadre), 'framed' (photo cadrée + ombre sur fond = la même
// photo floutée), 'mix'. Ken Burns (zoom/pano lent). Carte d'ouverture : titre + « En mémoire de … »
// + dates (naissance–décès) + citation.
//
// FONDU ENCHAÎNÉ SANS NOIR : chaque photo est sur une PISTE CROISSANTE et apparaît en fondu PAR-DESSUS
// la précédente (qui reste pleine en dessous) -> pas de creux sombre entre les photos.
// PHOTOS IMPORTANTES (`pinned` = liste d'URLs) : durée ×1.5.
// Durée calée sur la chanson (timing paroles), `maxDuration` borne. `clipStart` (s) = démarrer à un couplet.

'use strict';

const { cleanLyrics, timeLines } = require('./paroles-vivantes-timeline');

const BG = '#241019', CREAM = '#F5F0EA', GOLD = '#C4963A', MAUVE = '#E7C9D8';
const FONT_TITLE = 'Playfair Display', FONT_BODY = 'EB Garamond';
const W = 1280, H = 720, FPS = 25;
const INTRO = 4.0, OUTRO = 5, FADE = 0.12;     // voile très rapide (quasi clignement) -> photo nette dominante
const PHOTO_MIN = 3.6, PHOTO_MAX = 9.0;
const PIN = 1.5;                                // multiplicateur de durée d'une photo « importante »
const TRACK_BASE = 10;                          // photos sur des pistes croissantes à partir de 10

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
function blurredBg(url) { return url.replace('/upload/', '/upload/c_fill,w_1280,h_720,e_blur:2000,e_brightness:-28/'); }
function kenBurns(dur, i) {
  const A = [['28%','32%'], ['72%','34%'], ['32%','70%'], ['68%','66%'], ['50%','25%'], ['46%','74%']];
  const a = A[i % A.length];
  return { time: 0, duration: dur, easing: 'linear', type: 'scale', start_scale: '104%', end_scale: '120%', x_anchor: a[0], y_anchor: a[1] };
}

function buildVideoMemoire({ titre, prenom, cadeau, photos, lyrics, alignedWords, audioUrl,
                             clipStart = 0, style = 'fullscreen', maxDuration = 0,
                             naissance = '', deces = '', citation = '', pinned = [] }) {
  const list = (Array.isArray(photos) ? photos : []).filter(u => typeof u === 'string' && /^https:\/\//.test(u));
  if (!list.length) return null;
  const pinnedSet = new Set((Array.isArray(pinned) ? pinned : []).map(String));

  const t = timeLines(cleanLyrics(lyrics), alignedWords);
  let songEnd = t.songEnd, audioStartAt = 0, audioTrimStart = 0;
  if (clipStart > 0) { audioTrimStart = clipStart; audioStartAt = INTRO; songEnd = +(INTRO + (t.songEnd - clipStart)).toFixed(3); }
  if (maxDuration > 0) songEnd = Math.min(songEnd, +(INTRO + maxDuration).toFixed(3));

  const showStart = INTRO;
  const showEnd   = +Math.max(showStart + PHOTO_MIN, songEnd - OUTRO).toFixed(3);
  const span      = showEnd - showStart;
  const basePer   = Math.min(Math.max(span / list.length, PHOTO_MIN), PHOTO_MAX);

  // Séquence cumulée (boucle les photos si peu nombreuses ; ×1.5 pour les « importantes »).
  const seq = []; let acc = 0, idx = 0, guard = 0;
  while (acc < span - 0.05 && guard < 800) {
    const url = list[idx % list.length];
    let d = basePer * (pinnedSet.has(url) ? PIN : 1);
    if (acc + d > span) d = span - acc;
    seq.push({ url, time: +(showStart + acc).toFixed(3), dur: +(d + FADE).toFixed(3) });
    acc += d; idx++; guard++;
  }

  const elements = [];

  // Bande-son (piste 1).
  if (audioUrl) {
    const a = { type: 'audio', track: 1, time: audioStartAt, duration: +(songEnd - audioStartAt).toFixed(3),
                source: audioUrl, loop: false, audio_fade_out: 2.5 };
    if (clipStart > 0) { a.trim_start = audioTrimStart; a.audio_fade_in = 0.8; }
    elements.push(a);
  }

  // Photos en FONDU ENCHAÎNÉ (léger passage par le fond sombre, voulu). Pistes 3 & 4 alternées : la
  // suivante apparaît en fondu pendant que la précédente s'efface. FADE court = noir bref et discret.
  seq.forEach((s, i) => {
    const framed = style === 'framed' || (style === 'mix' && i % 2 === 1);
    const fadeAnims = [
      { time: 0,     duration: FADE, easing: 'quadratic-out', type: 'fade' },
      { time: 'end', duration: FADE, easing: 'quadratic-in',  type: 'fade', reversed: true }
    ];
    const tk = 3 + (i % 2);
    if (framed) {
      elements.push({ type: 'image', track: 2, time: s.time, duration: s.dur, source: blurredBg(s.url),
        width: '100%', height: '100%', fit: 'cover', animations: fadeAnims.slice() });
      elements.push({ type: 'image', track: tk, time: s.time, duration: s.dur, source: s.url,
        width: '74%', height: '74%', fit: 'cover', x_alignment: '50%', y_alignment: '47%',
        border_radius: '1.5 vmin', shadow_color: 'rgba(0,0,0,0.55)', shadow_blur: '4 vmin', shadow_y: '1 vmin',
        animations: [kenBurns(s.dur, i)].concat(fadeAnims) });
    } else {
      elements.push({ type: 'image', track: tk, time: s.time, duration: s.dur, source: s.url,
        width: '100%', height: '100%', fit: 'cover', x_alignment: '50%', y_alignment: '50%',
        animations: [kenBurns(s.dur, i)].concat(fadeAnims) });
    }
  });

  // Signature + cartes titre sur des pistes TRÈS hautes -> toujours au-dessus des photos.
  const TOP = 100;
  elements.push(textEl({ text: 'Chanson Mémoire', track: TOP, time: 0, duration: songEnd,
    family: FONT_TITLE, weight: '700', color: CREAM, size: 22, y: '93%' }));

  const titreAff  = sentenceCase(titre || 'Pour toujours', prenom);
  const prenomAff = capFirst(prenom);
  const datesStr  = (naissance && deces) ? (String(naissance).trim() + ' – ' + String(deces).trim())
                                         : String(naissance || deces || '').trim();
  const dedicace  = (cadeau ? 'Pour ' : 'En mémoire de ') + prenomAff + (datesStr ? '  ·  ' + datesStr : '');
  elements.push(textEl({ text: titreAff, track: TOP + 1, time: 0, duration: INTRO,
    family: FONT_TITLE, weight: '700', color: MAUVE, size: 62, y: '38%', fadeOut: true }));
  if (prenomAff) elements.push(textEl({ text: dedicace, track: TOP + 2, time: 0, duration: INTRO,
    family: FONT_BODY, weight: '400', color: GOLD, size: 28, y: '52%', fadeOut: true }));
  if (citation) elements.push(textEl({ text: '« ' + String(citation).trim() + ' »', track: TOP + 3, time: 0, duration: INTRO,
    family: FONT_BODY, weight: '400', color: CREAM, size: 24, y: '63%', fadeOut: true }));
  elements.push(textEl({ text: titreAff, track: TOP + 1, time: +Math.max(0, songEnd - OUTRO).toFixed(3), duration: OUTRO,
    family: FONT_TITLE, weight: '700', color: MAUVE, size: 54, y: '50%', fadeOut: true }));

  return { output_format: 'mp4', width: W, height: H, frame_rate: FPS, fill_color: BG, elements };
}

module.exports = { buildVideoMemoire, W, H, FPS };
