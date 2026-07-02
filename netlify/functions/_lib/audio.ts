// _lib/audio.ts — URLs audio Cloudinary signées (v2 Supabase).
//
// PORTAGE EXACT de buildAudioUrl/parseCloudinary de lire-projet.js (audit sécurité) :
//   - asset 'authenticated' -> URL SIGNÉE côté serveur ; la transformation (du_60 =
//     aperçu 60 s) est INCLUSE dans la signature SHA-1 -> impossible de la retirer (401) ;
//   - asset 'upload' (anciens tests publics) -> URL publique avec transformation ;
//   - l'URL complète n'est JAMAIS exposée avant achat.
// Signature déterministe, sans expiration (même lien re-cliquable depuis un courriel).
import { createHash } from 'node:crypto';

export interface AssetCloudinary {
  cloud: string;
  type: 'upload' | 'authenticated';
  publicId: string;
  ext: string;
}

export function parseCloudinary(url: string | null | undefined): AssetCloudinary | null {
  const m = /res\.cloudinary\.com\/([^/]+)\/video\/(upload|authenticated)\/(?:s--[^/]+--\/)?(?:v\d+\/)?(.+?)(\.\w+)?$/.exec(
    url || '',
  );
  return m
    ? { cloud: m[1]!, type: m[2] as 'upload' | 'authenticated', publicId: m[3]!, ext: m[4] || '' }
    : null;
}

// transformation = 'du_60' (aperçu 60 s) ou '' (chanson complète, après achat seulement).
export function buildAudioUrl(stored: string | null | undefined, transformation: string): string {
  const p = parseCloudinary(stored);
  if (!p) return '';
  const tf = transformation ? transformation + '/' : '';
  if (p.type === 'authenticated' && process.env.CLOUDINARY_API_SECRET) {
    const toSign = tf + p.publicId + p.ext;
    const sig = createHash('sha1')
      .update(toSign + process.env.CLOUDINARY_API_SECRET)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
      .slice(0, 8);
    return `https://res.cloudinary.com/${p.cloud}/video/authenticated/s--${sig}--/${tf}${p.publicId}${p.ext}`;
  }
  return `https://res.cloudinary.com/${p.cloud}/video/upload/${tf}${p.publicId}${p.ext}`;
}
