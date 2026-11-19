'use strict';

const { performance } = require('node:perf_hooks');
const { createOfficeFocusLiveStore, hash } = require('./office-focus-live-store');
const PATH = '/office/focus/live';

function registerOfficeFocusLive(app, { requireOfficeToken, api, json, db, encryptionKey, now, store = createOfficeFocusLiveStore({ db, encryptionKey, now }) }) {
  const noStore = (req, res, next) => {
    req.focusReceivedAt = performance.now();
    res.set('Cache-Control', 'no-store');
    if (!api) return res.status(404).json({ error: 'Live devices are available from the Office API.', code: 'FOCUS_LIVE_WRONG_SERVICE' });
    next();
  };
  const scope = req => hash(req.get('x-office-token'));
  const parse = json({ limit: '1kb', strict: true });
  const invalidBody = (error, _req, res, _next) =>
    res.status(error.status === 413 ? 413 : 400).json({ error: 'Invalid live device request.', code: 'FOCUS_LIVE_INVALID' });
  const route = handler => async (req, res) => {
    try { await handler(req, res); }
    catch (error) {
      if (error.focusLiveError) {
        if (error.status === 503) res.set('Retry-After', '3');
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      // Missing schema, lock timeouts, connection loss, and key mismatches are
      // retryable outages, never evidence that consent or a session expired.
      const code = String(error?.code || '');
      console.warn('[office live GPS] Shared storage unavailable' + (/^[A-Z0-9_]{2,40}$/.test(code) ? ` (${code}).` : '.'));
      res.set('Retry-After', '3').status(503).json({ error: 'Shared GPS storage is temporarily unavailable.', code: 'FOCUS_LIVE_UNAVAILABLE' });
    }
  };
  app.get(PATH, noStore, requireOfficeToken, route(async (req, res) => {
    res.json({ sources: await store.list(scope(req)) });
  }));
  app.post(PATH, noStore, requireOfficeToken, parse, invalidBody, route(async (req, res) => {
    res.status(201).json(await store.create(scope(req), req.body));
  }));
  app.put(PATH + '/:id', noStore, requireOfficeToken, parse, invalidBody, route(async (req, res) => {
    await store.update(scope(req), req.params.id, req.get('x-focus-publisher'), req.body, req.focusReceivedAt);
    res.status(204).end();
  }));
  app.delete(PATH + '/:id', noStore, requireOfficeToken, route(async (req, res) => {
    await store.cancel(scope(req), req.params.id, req.get('x-focus-publisher'));
    res.status(204).end();
  }));
  return store;
}

module.exports = { registerOfficeFocusLive };
