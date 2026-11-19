'use strict';

const { createHash, hkdfSync, randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createTokenVault } = require('./token-vault');

const POSITION_LIFETIME_MS = 25_000;
const SESSION_LIFETIME_MS = 90_000;
const SOURCE_CAPACITY = 40;
const SOURCE_TYPES = new Set(['phone', 'computer', 'equipment', 'bicycle', 'vehicle']);
const VEHICLE_TYPES = new Set(['sedan', 'hatchback', 'coupe', 'wagon', 'suv', 'pickup', 'van', 'truck', 'motorcycle', 'other']);
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const hash = value => createHash('sha256').update(value).digest('hex');
const date = value => new Date(value);
const between = (value, minimum, maximum) => Number.isFinite(value) && value >= minimum && value <= maximum;
const problem = (status, message, code) => { throw Object.assign(new Error(message), { status, code, focusLiveError: true }); };
const ended = () => problem(404, 'This location sharing session has ended.', 'FOCUS_LIVE_ENDED');

const OFFICE_FOCUS_LIVE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS office_focus_live_sessions (
    id UUID PRIMARY KEY, scope TEXT NOT NULL, publisher_hash TEXT NOT NULL,
    details TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
    fix TEXT, fix_at TIMESTAMPTZ
  )`,
  'CREATE INDEX IF NOT EXISTS office_focus_live_scope_idx ON office_focus_live_sessions(scope)',
  'CREATE INDEX IF NOT EXISTS office_focus_live_expiry_idx ON office_focus_live_sessions(updated_at)',
];

async function initializeOfficeFocusLive(db) {
  // IF NOT EXISTS alone does not serialize concurrent first-start DDL.
  return db.withClient(async client => {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock(1969645923, 1868981619)');
      for (const statement of OFFICE_FOCUS_LIVE_SCHEMA) await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}

function sourceDetails(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  const { kind, type } = input ?? {};
  if (!name || name.length > 80 || !SOURCE_TYPES.has(kind) || kind === 'vehicle' && !VEHICLE_TYPES.has(type)) return null;
  return { name, kind, type: kind === 'vehicle' ? type : '' };
}

function readPosition(input, time, elapsed) {
  const { latitude, longitude, accuracy, speed, heading, age } = input ?? {};
  if (!between(latitude, -90, 90) || !between(longitude, -180, 180) ||
    !between(accuracy, 0, 5000) || !between(age, 0, POSITION_LIFETIME_MS - 1) || age + elapsed >= POSITION_LIFETIME_MS) return null;
  return { latitude, longitude, accuracy, timestamp: time - age - elapsed,
    speed: between(speed, 0, 120) ? speed : null, heading: between(heading, 0, 359.9999) ? heading : null };
}

function createOfficeFocusLiveStore({ db, encryptionKey, now } = {}) {
  const rawKey = encryptionKey && Buffer.from(encryptionKey, 'base64');
  const validKey = rawKey?.length === 32 && rawKey.toString('base64') === encryptionKey;
  const key = validKey && Buffer.from(hkdfSync('sha256', rawKey, Buffer.from('uficonnect'),
    Buffer.from('office-focus-live-v1'), 32)).toString('base64');
  const vault = key && createTokenVault({ OAUTH_TOKEN_ENCRYPTION_KEY: key });
  const seal = (scope, id, field, value) => vault.seal(JSON.stringify(value), `office-live:${scope}:${id}:${field}`);
  const open = (scope, id, field, value) => JSON.parse(vault.open(value, `office-live:${scope}:${id}:${field}`));

  async function transaction(scope, operation) {
    // Never fall back to a worker-local map or the feed's read-only backup.
    if (!vault || !db?.isConnected() || !db.withClient) {
      problem(503, 'Shared GPS storage is temporarily unavailable.', 'FOCUS_LIVE_UNAVAILABLE');
    }
    return db.withClient(async client => {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      try {
        await client.query("SET LOCAL statement_timeout = '3000ms'");
        await client.query("SET LOCAL lock_timeout = '1500ms'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '5000ms'");
        // Serialize the small Office-wide set, including capacity checks and
        // cancellation. Transaction locks are released even if a worker dies.
        if (scope) await client.query('SELECT pg_advisory_xact_lock(1969645923, hashtext($1))', [scope]);
        // Sample after waiting for the lock. Workers need not agree on clocks.
        const time = now ? now() : new Date((await client.query('SELECT clock_timestamp() AS time')).rows[0].time).getTime();
        const result = await operation(client, time);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    });
  }

  async function prune(client, time, scope = null) {
    await client.query('DELETE FROM office_focus_live_sessions WHERE updated_at <= $1 AND ($2::text IS NULL OR scope=$2)',
      [date(time - SESSION_LIFETIME_MS), scope]);
    // Keep fix_at as a high-water mark: erasing coordinates must not allow an
    // older or duplicate reading to reappear or extend the session lease.
    await client.query('UPDATE office_focus_live_sessions SET fix=NULL WHERE fix IS NOT NULL AND fix_at <= $1 AND ($2::text IS NULL OR scope=$2)',
      [date(time - POSITION_LIFETIME_MS), scope]);
  }

  async function publisher(client, scope, id, credential) {
    if (!UUID.test(id || '') || !UUID.test(credential || '')) ended();
    const { rows } = await client.query('SELECT * FROM office_focus_live_sessions WHERE scope=$1 AND id=$2 AND publisher_hash=$3 FOR UPDATE',
      [scope, id, hash(credential)]);
    if (!rows[0]) ended();
    return rows[0];
  }

  return {
    create: (scope, input) => {
      const details = sourceDetails(input);
      if (!details) problem(400, 'Provide a name and a supported tracking type.', 'FOCUS_LIVE_INVALID');
      return transaction(scope, async (client, time) => {
        await prune(client, time, scope);
        const { rows } = await client.query('SELECT COUNT(*)::int AS count FROM office_focus_live_sessions WHERE scope=$1', [scope]);
        if (rows[0].count >= SOURCE_CAPACITY) problem(429, 'Too many active sharing sessions.', 'FOCUS_LIVE_CAPACITY');
        const id = randomUUID(), credential = randomUUID();
        await client.query(`INSERT INTO office_focus_live_sessions (id,scope,publisher_hash,details,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$5)`, [id, scope, hash(credential), seal(scope, id, 'details', details), date(time)]);
        return { id, publisher: credential };
      });
    },

    list: scope => transaction(scope, async (client, time) => {
      await prune(client, time, scope);
      const { rows } = await client.query('SELECT id,details,created_at,fix,fix_at FROM office_focus_live_sessions WHERE scope=$1 AND fix IS NOT NULL ORDER BY created_at,id', [scope]);
      return rows.map(row => {
        const { timestamp, ...coords } = open(scope, row.id, 'fix', row.fix);
        return { id: row.id, ...open(scope, row.id, 'details', row.details), firstSharedAt: new Date(row.created_at).getTime(),
          evidence: 'office-device-gps', labelType: 'publisher-supplied', observedAt: timestamp, fix: { ...coords, age: time - timestamp } };
      });
    }),

    update: (scope, id, credential, input, receivedAt = performance.now()) => transaction(scope, async (client, time) => {
      await prune(client, time, scope);
      const row = await publisher(client, scope, id, credential);
      const fix = readPosition(input, time, Math.max(0, Math.round(performance.now() - receivedAt)));
      if (!fix) problem(400, 'A fresh GPS reading is required.', 'FOCUS_LIVE_INVALID');
      if (row.fix_at && fix.timestamp <= new Date(row.fix_at).getTime()) return;
      if (row.fix_at && time - new Date(row.updated_at).getTime() < 1000) {
        problem(429, 'Wait for the next GPS update.', 'FOCUS_LIVE_RATE_LIMIT');
      }
      // UPDATE only: a delayed request must never recreate a revoked session.
      await client.query('UPDATE office_focus_live_sessions SET fix=$3,fix_at=$4,updated_at=$5 WHERE scope=$1 AND id=$2',
        [scope, id, seal(scope, id, 'fix', fix), date(fix.timestamp), date(time)]);
    }),

    cancel: (scope, id, credential) => transaction(scope, async (client, time) => {
      await prune(client, time, scope);
      await publisher(client, scope, id, credential);
      await client.query('DELETE FROM office_focus_live_sessions WHERE scope=$1 AND id=$2', [scope, id]);
    }),

    prune: () => transaction(null, (client, time) => prune(client, time)),
  };
}

module.exports = { createOfficeFocusLiveStore, initializeOfficeFocusLive, OFFICE_FOCUS_LIVE_SCHEMA,
  POSITION_LIFETIME_MS, SESSION_LIFETIME_MS, SOURCE_CAPACITY, hash };
