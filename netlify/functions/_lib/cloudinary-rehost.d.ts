// Types du module legacy _lib/cloudinary-rehost.js (upload signé par URL, éprouvé).
// rehost renvoie le secure_url Cloudinary, ou null si non configuré / échec
// (l'appelant garde alors l'URL d'origine).
export function rehost(
  remoteUrl: string,
  options?: { folder?: string; publicId?: string; resourceType?: string; type?: string },
): Promise<string | null>;
export function rename(fromPublicId: string, toPublicId: string, options?: Record<string, unknown>): Promise<unknown>;
export function parseCloudinaryUrl(url: string): unknown;
export function destroy(publicId: string, options?: Record<string, unknown>): Promise<unknown>;
