// Types du module legacy _lib/sentry.js (lazy-Sentry), consommé par le nouveau code TS.
// Le .js reste la seule implémentation ; il disparaîtra avec le portage Phase 2+.
export function capture(err: unknown, extra?: Record<string, unknown>): Promise<void>;
export function withSentry(
  handler: (event: unknown, context: unknown) => Promise<unknown>,
): (event: unknown, context: unknown) => Promise<unknown>;
