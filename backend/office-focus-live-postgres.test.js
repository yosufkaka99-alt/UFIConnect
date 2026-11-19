'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const http = require('node:http');
const { Pool } = require('pg');
const { encryptionKey } = require('./test-support/office-focus-live-db');

const connectionString = process.env.FOCUS_LIVE_TEST_POSTGRES_URL;
const livePath = '/office/focus/live';
const headers = { 'x-office-token': 'postgres-worker-test-only' };
const profile = { name: 'Authorized test phone', kind: 'phone' };
const point = { latitude: 37, longitude: -122, accuracy: 4, age: 0 };

function message(child, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Worker did not report ${event}`)), 7000);
    const onMessage = value => { if (value.event === event) finish(null, value); };
    const onExit = () => finish(new Error(`Worker exited before ${event}`));
    function finish(error, value) {
      clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit);
      if (error) reject(error); else resolve(value);
    }
    child.on('message', onMessage); child.on('exit', onExit);
  });
}

test('independent API worker processes share real PostgreSQL state and recover from a killed worker',
  { skip: !connectionString && 'Set FOCUS_LIVE_TEST_POSTGRES_URL to a disposable local PostgreSQL instance.', timeout: 60000 }, async t => {
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connectionString).hostname), 'Use a local test database.');
    const schema = `focus_live_test_${randomUUID().replace(/-/g, '')}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    const children = new Set();
    t.after(async () => {
      await Promise.all([...children].map(async child => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      }));
      await pool.end();
      try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); }
    });
    async function boot(skew = 0) {
      const child = fork(path.join(__dirname, 'test-support/office-focus-live-worker.js'), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        env: { ...process.env, FOCUS_LIVE_TEST_POSTGRES_URL: connectionString, FOCUS_LIVE_TEST_SCHEMA: schema,
          FOCUS_LIVE_TEST_ENCRYPTION_KEY: encryptionKey, FOCUS_LIVE_WORKER_CLOCK_SKEW: String(skew) } });
      children.add(child);
      const ready = await message(child, 'ready');
      return { child, origin: `http://127.0.0.1:${ready.port}` };
    }
    async function request(worker, endpoint = livePath, { method = 'GET', body, extra = {} } = {}) {
      const response = await fetch(worker.origin + endpoint, { method,
        headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}), ...extra },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(6000) });
      const text = await response.text();
      return { status: response.status, data: text ? JSON.parse(text) : null };
    }
    const create = worker => request(worker, livePath, { method: 'POST', body: profile });
    const publish = (worker, record, body = point) => request(worker, livePath + '/' + record.id,
      { method: 'PUT', body, extra: { 'x-focus-publisher': record.publisher } });
    const cancel = (worker, record) => request(worker, livePath + '/' + record.id,
      { method: 'DELETE', extra: { 'x-focus-publisher': record.publisher } });
    const clear = () => pool.query('DELETE FROM office_focus_live_sessions');
    let [a, b] = await Promise.all([boot(3600000), boot(-3600000)]);

    await t.test('concurrent first-start migrations create one shared session table', async () => {
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM office_focus_live_sessions')).rows[0].count, 0);
    });

    await t.test('create on A, update on B, read on A, restart A and cancel on B', async () => {
      const created = await create(a); assert.equal(created.status, 201);
      const record = created.data;
      assert.equal((await publish(b, record)).status, 204);
      const snapshot = (await request(a)).data.sources;
      assert.equal(snapshot.length, 1);
      assert.equal(snapshot[0].id, record.id);
      const databaseNow = new Date((await pool.query('SELECT clock_timestamp() AS time')).rows[0].time).getTime();
      assert.ok(Math.abs(snapshot[0].firstSharedAt - databaseNow) < 5000, 'worker clock skew cannot change session lifetime');
      const exited = once(a.child, 'exit'); a.child.kill('SIGKILL'); await exited;
      a = await boot();
      assert.equal((await request(a)).data.sources[0].id, record.id);
      assert.equal((await cancel(b, record)).status, 204);
      assert.equal((await publish(a, record)).data.code, 'FOCUS_LIVE_ENDED');
      assert.deepEqual((await request(b)).data.sources, []);
    });

    await t.test('concurrent enrollments enforce one shared capacity limit', async () => {
      await clear();
      const results = await Promise.all(Array.from({ length: 42 }, (_, i) => create(i % 2 ? a : b)));
      assert.equal(results.filter(result => result.status === 201).length, 40);
      assert.equal(results.filter(result => result.status === 429).length, 2);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM office_focus_live_sessions')).rows[0].count, 40);
    });

    await t.test('stale fixes and inactive sessions expire across workers without renewal by reads', async () => {
      await clear();
      const record = (await create(a)).data;
      assert.equal((await publish(b, record)).status, 204);
      await pool.query("UPDATE office_focus_live_sessions SET fix_at=clock_timestamp()-INTERVAL '25 seconds'");
      assert.deepEqual((await request(a)).data.sources, []);
      assert.equal((await pool.query('SELECT fix FROM office_focus_live_sessions')).rows[0].fix, null);
      await pool.query("UPDATE office_focus_live_sessions SET updated_at=clock_timestamp()-INTERVAL '2 seconds'");
      assert.equal((await publish(a, record)).status, 204, 'a fresh reading restores an active session');
      await pool.query("UPDATE office_focus_live_sessions SET updated_at=clock_timestamp()-INTERVAL '90 seconds'");
      assert.equal((await publish(b, record)).status, 404);
      assert.deepEqual((await request(a)).data.sources, []);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM office_focus_live_sessions')).rows[0].count, 0);
    });

    await t.test('killing a worker before COMMIT rolls back the update and releases locks', async () => {
      await clear();
      const record = (await create(a)).data;
      await publish(b, record);
      await pool.query("UPDATE office_focus_live_sessions SET updated_at=clock_timestamp()-INTERVAL '2 seconds'");
      const ack = message(a.child, 'ack'); a.child.send({ command: 'pauseCommit' }); await ack;
      const paused = message(a.child, 'paused');
      const pending = publish(a, record, { ...point, latitude: 38 }).catch(() => null);
      await paused;
      const exited = once(a.child, 'exit'); a.child.kill('SIGKILL'); await exited; await pending;
      assert.equal((await request(b)).data.sources[0].fix.latitude, 37, 'uncommitted coordinates are never visible');
      a = await boot();
      assert.equal((await publish(a, record, { ...point, latitude: 39 })).status, 204);
      assert.equal((await request(b)).data.sources[0].fix.latitude, 39);
    });

    await t.test('a PUT whose body finishes after cancellation cannot recreate the session', async () => {
      await clear();
      const record = (await create(a)).data;
      const body = JSON.stringify(point);
      let write;
      const pending = new Promise((resolve, reject) => {
        write = http.request(a.origin + livePath + '/' + record.id, { method: 'PUT', headers: { ...headers,
          'x-focus-publisher': record.publisher, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
          res.resume(); res.once('end', () => resolve(res.statusCode));
        });
        write.on('error', reject); write.write(body.slice(0, -1));
      });
      assert.equal((await cancel(b, record)).status, 204);
      write.end(body.slice(-1));
      assert.equal(await pending, 404);
      assert.deepEqual((await request(a)).data.sources, []);
    });

    await t.test('concurrent updates, reads and cancellation never resurrect a session', async () => {
      await clear();
      const record = (await create(a)).data;
      const outcomes = await Promise.all([publish(a, record), publish(b, record, { ...point, age: 10000 }),
        request(a), cancel(b, record), publish(a, record)]);
      assert.equal(outcomes[3].status, 204);
      assert.ok(outcomes.filter((_, i) => [0, 1, 4].includes(i)).every(result => [204, 404, 429].includes(result.status)));
      assert.deepEqual((await request(b)).data.sources, []);
      assert.equal((await publish(a, record)).status, 404);
    });
  });
