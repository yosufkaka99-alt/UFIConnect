'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { performance } = require('node:perf_hooks');
const { createLiveDatabase } = require('./test-support/office-focus-live-db');
const { createOfficeFocusLiveStore, hash } = require('./office-focus-live-store');
const { registerOfficeFocusLive } = require('./office-focus-live');
const { createAppHarness } = require('./test-support/app-harness');

const scope = hash('office-test-only');
const otherScope = hash('another-office');
const profile = { name: 'Private delivery phone', kind: 'phone' };
const point = { latitude: 37.123456, longitude: -122.123456, accuracy: 4, age: 0 };
const fails = status => error => error.focusLiveError && error.status === status;

async function fixture(t) {
  const data = await createLiveDatabase();
  t.after(() => data.close());
  let time = 1000000;
  const make = options => createOfficeFocusLiveStore({ ...data, now: () => time, ...options });
  return { ...data, make, advance: ms => { time += ms; } };
}

test('independent stores share encrypted sessions, preserve permissions and survive reinitialization', async t => {
  const f = await fixture(t), first = f.make(), second = f.make();
  const record = await first.create(scope, profile);
  await second.update(scope, record.id, record.publisher, point);
  const snapshot = await first.list(scope);
  assert.equal(snapshot[0].id, record.id);
  assert.equal(snapshot[0].fix.latitude, point.latitude);
  assert.deepEqual(await second.list(otherScope), []);
  await assert.rejects(second.update(otherScope, record.id, record.publisher, point), fails(404));
  await assert.rejects(second.cancel(scope, record.id, 'wrong-publisher'), fails(404));
  const row = (await f.db.query('SELECT * FROM office_focus_live_sessions')).rows[0];
  assert.match(row.fix, /^enc:v1:/);
  assert.match(row.details, /^enc:v1:/);
  assert.equal(row.publisher_hash, hash(record.publisher));
  assert.doesNotMatch(JSON.stringify(row), /Private delivery phone|37\.123456/);
  assert.ok(!JSON.stringify(snapshot).includes(record.publisher));
  assert.deepEqual(await f.make().list(scope), snapshot, 'a new store does not lose the session');
  await f.make().cancel(scope, record.id, record.publisher);
  await assert.rejects(first.update(scope, record.id, record.publisher, point), fails(404));
  assert.deepEqual(await second.list(scope), []);
});

test('freshness, rate limits and out-of-order updates never extend an expired lease', async t => {
  const f = await fixture(t), first = f.make(), second = f.make();
  const { id, publisher } = await first.create(scope, profile);
  await first.update(scope, id, publisher, point);
  f.advance(100);
  await assert.rejects(second.update(scope, id, publisher, point), fails(429));
  f.advance(1900);
  await second.update(scope, id, publisher, { ...point, longitude: 22, age: 2100 });
  assert.equal((await first.list(scope))[0].fix.longitude, point.longitude, 'an older fix is ignored');
  const before = (await f.db.query('SELECT updated_at FROM office_focus_live_sessions')).rows[0].updated_at;
  f.advance(23000);
  assert.deepEqual(await second.list(scope), [], 'coordinates disappear at the 25-second boundary');
  assert.equal((await f.db.query('SELECT fix FROM office_focus_live_sessions')).rows[0].fix, null);
  await assert.rejects(second.update(scope, id, publisher, { ...point, age: 25000 }), fails(400));
  await assert.rejects(second.update(scope, id, publisher, point, performance.now() - 25000), fails(400), 'queueing counts against freshness');
  assert.deepEqual((await f.db.query('SELECT updated_at FROM office_focus_live_sessions')).rows[0].updated_at, before);
  await second.update(scope, id, publisher, point);
  f.advance(89999);
  await assert.rejects(first.update(scope, id, publisher, { ...point, age: -1 }), fails(400));
  f.advance(1);
  await assert.rejects(first.update(scope, id, publisher, point), fails(404));
  assert.deepEqual(await f.make().list(scope), []);
});

test('scope capacity is shared and empty unpublished sessions expire without a heartbeat', async t => {
  const f = await fixture(t), a = f.make(), b = f.make();
  const outcomes = await Promise.allSettled(Array.from({ length: 42 }, (_, i) => (i % 2 ? a : b).create(scope, profile)));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 40);
  assert.ok(outcomes.filter(result => result.status === 'rejected').every(result => result.reason.status === 429));
  assert.deepEqual(await a.list(scope), [], 'enrollment never implies a GPS observation');
  f.advance(90000);
  await b.prune();
  assert.equal((await f.db.query('SELECT COUNT(*)::int AS count FROM office_focus_live_sessions')).rows[0].count, 0);
  assert.ok((await a.create(scope, profile)).id);
});

test('shared storage outages, missing schema and mismatched encryption keys return retryable 503 responses', async t => {
  const f = await fixture(t);
  const token = 'office-test-only';
  let mode = 'ready';
  const db = { ...f.db, isConnected: () => mode !== 'offline',
    withClient: work => mode === 'error' ? Promise.reject(new Error('postgres://private-secret@private-host')) : f.db.withClient(work) };
  const store = createOfficeFocusLiveStore({ db, encryptionKey: f.encryptionKey });
  const app = await createAppHarness({ env: { OFFICE_TOKEN: token }, modules: {
    './office-focus-live': { registerOfficeFocusLive: (app, options) => registerOfficeFocusLive(app, { ...options, store }) },
  } });
  t.after(() => app.close());
  const headers = { 'x-office-token': token };
  const created = await app.request('/office/focus/live', { method: 'POST', headers, body: profile });
  const { id, publisher } = created.data;
  const updateHeaders = { ...headers, 'x-focus-publisher': publisher };
  assert.equal((await app.request('/office/focus/live/' + id, { method: 'PUT', headers: updateHeaders, body: point })).status, 204);
  for (const failure of ['offline', 'error']) {
    mode = failure;
    for (const [method, url, body, requestHeaders] of [
      ['GET', '/office/focus/live', undefined, headers],
      ['POST', '/office/focus/live', profile, headers],
      ['PUT', '/office/focus/live/' + id, point, updateHeaders],
      ['DELETE', '/office/focus/live/' + id, undefined, updateHeaders],
    ]) {
      const response = await app.request(url, { method, headers: requestHeaders, body });
      assert.equal(response.status, 503);
      assert.equal(response.data.code, 'FOCUS_LIVE_UNAVAILABLE');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.doesNotMatch(JSON.stringify(response.data), /private-secret|private-host|postgres/);
    }
  }
  mode = 'ready';
  assert.equal((await app.request('/office/focus/live', { headers })).data.sources.length, 1);
  await assert.rejects(f.make({ encryptionKey: Buffer.alloc(32, 99).toString('base64') }).list(scope));
  await f.db.query('DROP TABLE office_focus_live_sessions');
  assert.equal((await app.request('/office/focus/live', { headers })).status, 503);
  await assert.rejects(createOfficeFocusLiveStore({ db: f.db }).list(scope), fails(503));
});
