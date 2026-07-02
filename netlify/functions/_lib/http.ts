// _lib/http.ts — wrapper d'erreur COMMUN, obligatoire sur toute fonction TS
// (imposé par scripts/verifier-wrapper.mjs en CI). Plan v2 §5.
//
// Garanties :
//   - catch global : aucune exception ne s'échappe sans log structuré + Sentry + 5xx ;
//   - jamais d'erreur maquillée en 200 : une 5xx retournée par le handler est
//     journalisée aussi (pas seulement les exceptions) ;
//   - aucun détail interne (stack, token, courriel) ne fuit vers le client :
//     le corps d'erreur est générique, le détail va au journal (nettoyé).
import { journaliser, nettoyer, type Niveau } from './journal';
import { capture } from './sentry';

export interface EvenementHttp {
  httpMethod: string;
  path: string;
  headers: Record<string, string | undefined>;
  queryStringParameters: Record<string, string | undefined> | null;
  body: string | null;
  isBase64Encoded?: boolean;
}

export interface ReponseHttp {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

export type Gestionnaire = (event: EvenementHttp, context: unknown) => Promise<ReponseHttp>;

interface Options {
  // Gravité d'un échec de CETTE fonction (défaut P1 : dans le doute, on crie).
  niveauEchec?: Niveau;
}

export function avecErreurs(fonction: string, gestionnaire: Gestionnaire, options: Options = {}): Gestionnaire {
  const niveau: Niveau = options.niveauEchec ?? 'P1';
  return async (event, context) => {
    try {
      const reponse = await gestionnaire(event, context);
      if (reponse.statusCode >= 500) {
        // Le handler a signalé un échec proprement : on le journalise quand même,
        // pour qu'aucun 5xx ne soit invisible.
        journaliser({
          niveau,
          fonction,
          message: `réponse ${reponse.statusCode}`,
          chemin: nettoyer(event?.path ?? ''),
        });
      }
      return reponse;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error && err.stack ? nettoyer(err.stack) : undefined;
      journaliser({ niveau, fonction, message, stack, chemin: nettoyer(event?.path ?? '') });
      try {
        await capture(err, { fonction });
      } catch {
        // Sentry en panne ne doit pas masquer l'erreur d'origine : elle est déjà
        // journalisée ci-dessus, et la 500 part au client quoi qu'il arrive.
      }
      return {
        statusCode: 500,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'Erreur interne' }),
      };
    }
  };
}
