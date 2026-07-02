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
//
// ALGORITHME DE SIGNATURE (alerte CodeQL js/weak-cryptographic-algorithm, assumée) :
// SHA-1 est le schéma de signature d'URL de LIVRAISON de Cloudinary (signature courte
// 8 caractères), utilisé par TOUT le système actuel (lire-projet, lire-versions,
// cloudinary-rehost…). Ce n'est pas un choix de crypto maison : c'est le format que
// Cloudinary valide pour les assets déjà en prod. Risque réel faible : le secret ne
// quitte jamais le serveur, aucune forge hors-ligne possible, et l'enjeu est la
// distinction aperçu 60 s / chanson complète.
// CHEMIN DE SORTIE : Cloudinary supporte SHA-256 (« long URL signature », 32 car.).
// Poser CLOUDINARY_SIGN_ALGO=sha256 APRÈS avoir activé ce réglage dans le compte
// Cloudinary (sinon les URLs signées seraient refusées) : bascule sans redéploiement.
export function buildAudioUrl(stored: string | null | undefined, transformation: string): string {
  const p = parseCloudinary(stored);
  if (!p) return '';
  const tf = transformation ? transformation + '/' : '';
  if (p.type === 'authenticated' && process.env.CLOUDINARY_API_SECRET) {
    const sha256 = process.env.CLOUDINARY_SIGN_ALGO === 'sha256';
    const toSign = tf + p.publicId + p.ext;
    const sig = createHash(sha256 ? 'sha256' : 'sha1')
      .update(toSign + process.env.CLOUDINARY_API_SECRET)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
      .slice(0, sha256 ? 32 : 8);
    return `https://res.cloudinary.com/${p.cloud}/video/authenticated/s--${sig}--/${tf}${p.publicId}${p.ext}`;
  }
  return `https://res.cloudinary.com/${p.cloud}/video/upload/${tf}${p.publicId}${p.ext}`;
}
