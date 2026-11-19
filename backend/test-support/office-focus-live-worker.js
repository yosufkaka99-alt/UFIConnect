'use strict';

// Disposable local PostgreSQL only; launched by the cross-worker regression.
const express = require('express');
const { Pool } = require('pg');
const { registerOfficeFocusLive } = require('../office-focus-live');
const { initializeOfficeFocusLive } = require('../office-focus-live-store');
const nativeNow = Date.now;
Date.now = () => nativeNow() + Number(process.env.FOCUS_LIVE_WORKER_CLOCK_SKEW || 0);
const pool = new Pool({ connectionString: process.env.FOCUS_LIVE_TEST_POSTGRES_URL,
  options: `-c search_path=${process.env.FOCUS_LIVE_TEST_SCHEMA}`, max: 8 });
pool.on('error', () => {});
let pauseCommit = false;
let resume;
const db = {
  isConnected: () => true,
  query: pool.query.bind(pool),
  withClient: async work => {
    const client = await pool.connect();
    const onError = () => {};
    client.on('error', onError);
    try {
      return await work({ query: async (sql, params) => {
        if (sql === 'COMMIT' && pauseCommit) {
          pauseCommit = false;
          await new Promise(resolve => { resume = resolve; process.send({ event: 'paused', backendPid: client.processID }); });
        }
        return client.query(sql, params);
      } });
    } finally { client.removeListener('error', onError); client.release(); }
  },
};
const app = express();
registerOfficeFocusLive(app, { db, api: true, json: express.json,
  encryptionKey: process.env.FOCUS_LIVE_TEST_ENCRYPTION_KEY,
  requireOfficeToken: (req, res, next) => req.get('x-office-token') === 'postgres-worker-test-only' ? next() : res.sendStatus(401) });
let server;
initializeOfficeFocusLive(db).then(() => {
  server = app.listen(0, '127.0.0.1', () => process.send({ event: 'ready', port: server.address().port }));
}).catch(() => process.exit(1));
process.on('message', message => {
  if (message.command === 'pauseCommit') pauseCommit = true;
  if (message.command === 'resume') { resume?.(); resume = null; }
  process.send({ event: 'ack', command: message.command });
});
