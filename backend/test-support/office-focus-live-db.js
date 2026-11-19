'use strict';

const { PGlite } = require('@electric-sql/pglite');
const { OFFICE_FOCUS_LIVE_SCHEMA } = require('../office-focus-live-store');
const encryptionKey = Buffer.alloc(32, 31).toString('base64');

async function createLiveDatabase() {
  const pg = new PGlite();
  for (const statement of OFFICE_FOCUS_LIVE_SCHEMA) await pg.query(statement);
  let tail = Promise.resolve();
  const db = {
    isConnected: () => true,
    query: pg.query.bind(pg),
    // PGlite has one connection. Real independent-connection and worker-death
    // coverage lives in office-focus-live-postgres.test.js.
    withClient(work) {
      const result = tail.then(() => work({ query: pg.query.bind(pg) }));
      tail = result.catch(() => {});
      return result;
    },
  };
  return { db, pg, encryptionKey, close: async () => { await tail; await pg.close(); } };
}

module.exports = { createLiveDatabase, encryptionKey };
