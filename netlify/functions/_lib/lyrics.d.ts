// Types du module legacy _lib/lyrics.js, consommé par le nouveau code TS.
// stripSectionTags : masque les balises Suno ([Verse], [Chorus]…) à l'affichage client.
// accentFor : accent linguistique ajouté au prompt de style Suno selon la langue.
export function stripSectionTags(text: string | null | undefined): string;
export function accentFor(code: string | null | undefined): string;
