// _lib/cron.js — Wrapper standard pour TOUS les crons : heartbeat Healthchecks (dead man's switch)
// + capture Sentry des exceptions, en une ligne. Conformite : chaque cron doit etre observable.
//
// Usage (a la fin du fichier, apres la definition du handler) :
//   const { withCron } = require('./_lib/cron');
//   exports.handler = withCron('recovery-cron', exports.handler);
//
// - Succes (le handler retourne) -> beat(name)        : Healthchecks reste vert.
// - Erreur (le handler jette)    -> capture + beat(name,'fail') puis on relance : la run est marquee
//   echouee (Netlify + Healthchecks), l'erreur est dans Sentry. Inerte si SENTRY_DSN/HC_PING_KEY absents.

const { capture } = require('./sentry');
const { beat } = require('./heartbeat');

function withCron(name, handler) {
  return async (event, context) => {
    try {
      const res = await handler(event, context);
      await beat(name);
      return res;
    } catch (err) {
      await capture(err, { cron: name });
      await beat(name, true);
      throw err;
    }
  };
}

module.exports = { withCron };
