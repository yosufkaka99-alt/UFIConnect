# Proposed Office Live Maps worker consistency correction

Prepared November 18, 2026. Base: `6515cd436a3a20af4f045a2d943c723d5ee404e8` (current main when work began).

## Confirmed problem and scope

[PR #314](https://github.com/UFIConnect/UFIConnect/pull/314) stores sessions in a Map owned by each call to `registerOfficeFocusLive`. [The unresolved review](https://github.com/UFIConnect/UFIConnect/pull/314#discussion_r4595397285) still applies to the inspected main branch. `npm start` starts `backend/server.js`, which forks workers and replaces crashed workers. Creating a session on one worker does not make it available on another. Office previously stopped publishing on any HTTP 404.

The repository's Render blueprint currently declares `index.js` directly for the API, while the package's supported default entry point is clustered. The actual deployed start command, worker/instance count, and production interruption rate have **not** been verified. This is a reproduced defect in a supported configuration, not a measurement of production incidents.

## Proposed implementation

Use the existing primary PostgreSQL database, through `db.withClient`, for a shared `office_focus_live_sessions` table. No new database, Redis service, package dependency, worker count change, or deployment setting is required.

- Creation commits a session before returning its ID and random publisher credential. An enrolled session has no location until an explicitly consenting publisher sends a fresh GPS reading.
- All routes retain `requireOfficeToken`. A hash of the authenticated Office token scopes the shared set. Another Office token cannot read or mutate that set. This preserves the existing Office-wide access model; these endpoints do not add per-member identity verification. Device labels remain explicitly publisher supplied.
- Labels and the last GPS fix use authenticated encryption with a domain-separated key derived from the existing `OAUTH_TOKEN_ENCRYPTION_KEY`. Publisher credentials are stored only as SHA-256 hashes and never returned in device lists. The browser keeps its credential in memory.
- Short read-committed transactions take an Office-scoped advisory lock. Creation/capacity checks, reads, updates, expiration, and deletion therefore observe committed shared state across processes and instances. Row locks and update-only writes prevent delayed PUTs from recreating canceled sessions.
- Concurrent first-start schema creation uses a separate transaction-scoped advisory lock. A crashed worker releases database locks, and incomplete writes roll back. Replacing a worker does not erase committed sessions.
- The primary database clock determines lifetime after the scope lock is acquired. Server-side request parsing, pool waiting, and lock waiting count against submitted GPS age. Worker wall-clock skew cannot change the server's expiration rules.
- Positions disappear at 25 seconds; inactive sessions end at 90 seconds. Only an accepted newer fix renews a session. Reads, rejected, older, duplicate, or rate-limited updates do not renew it. The one-second update limit and 40-session capacity apply across workers.
- Coordinates are cleared on request cleanup and a five-second maintenance sweep. Expired sessions are deleted. The last accepted observation timestamp remains until session deletion to preserve ordering. There is no location history table.
- Missing schema, unavailable storage, lock timeouts, and decryption errors return HTTP 503 with `FOCUS_LIVE_UNAVAILABLE`, `Retry-After`, and `Cache-Control: no-store`. Errors log only a bounded error code. The feed's read-only backup and worker-local memory are never used as fallbacks.

## Office behavior and shutdown

Temporary network failures, HTTP 503/429, and unclassified gateway 404s retry with backoff using the existing publisher credential. Only an authoritative `404 FOCUS_LIVE_ENDED` or HTTP 401/403/423 ends publishing immediately. A local 90-second lease bounds retrying and requires an explicit new sharing action after expiration. Office never automatically enrolls a replacement session.

Viewing retains an accepted observation only while it is still fresh; failures and repeated reads do not make an old position fresh again. Existing tests cover hiding expired markers and clearing observations when access is denied.

Stop sharing, hiding the page, stopping local GPS, closing Focus, changing transport, or unmounting cancels local publishing. Stop prevents late responses and reconnect events from restarting publishing. If creation completes after Stop, Office now consumes the response and requests revocation instead of abandoning the newly created session. Revocation uses the session's original transport and publisher credential.

Existing native phone pairing, account/session checks, separate sharing consent, geofence rules, and permission handling remain in their existing paths. This change does not extend browser tracking into OS background execution.

## Local verification

| Check | Result | Coverage |
| --- | --- | --- |
| Focus/store/auth/location/polling regression run | 75 passed | Office authorization, publisher credentials, isolated Office scopes, encrypted storage, expiry boundaries, ordering, queue age, rate/capacity limits, outage recovery, native Focus consent and token-vault behavior |
| Real PostgreSQL 18.6, separate API processes | 8 passed | Concurrent initial migration; A-create/B-update/A-read; restart; skewed worker clocks; simultaneous capacity requests; stale fixes/session expiry; killing a worker before COMMIT; body parsing across cancellation; concurrent updates, reads and cancellation |
| Targeted Chromium 153 browser run | 14 passed | Two-device sharing and revocation; mobile grid cards; viewer freshness on outage; publisher network/404/503/429 retry; 401/403/423/authoritative 404 shutdown; offline lease expiry; late enrollment after Stop, hiding, stopping GPS and closing Focus |
| Release-verification reuse tests | 6 passed | Exact-source verification reuse and fail-closed fallback |
| Office transport security tests | 5 passed | Header authentication, stream cancellation, refused insecure/cross-origin credential forwarding |
| Office production build | Passed | Build completes; existing large-chunk advisory remains |
| JavaScript/JSX reference check | Passed | All 1,075 files parse without unbound references |
| Deployment workflow security check | Passed | YAML parses and deployment/security gates remain configured |
| Git whitespace check | Passed | No whitespace errors |

The standard installed Chromium could not start because this executor restricts Unix sockets; its normal browser download also failed. The browser suite ran successfully using a separately downloaded Chromium 153 headless shell through the suite's existing `CHROMIUM_EXECUTABLE_PATH` option. Temporary browser and PostgreSQL tools are excluded from Git; production dependencies are unchanged.

Reproduce the relevant checks:

```sh
node --test --test-concurrency=2 backend/focus-sync.test.js backend/office-focus-live.test.js backend/office-focus-live-store.test.js backend/token-vault.test.js office/src/focus-geofence.test.mjs office/src/focus-tracking.test.mjs office/src/focus-movement.test.mjs office/src/office-polling.test.mjs office/src/office-requests.test.mjs
FOCUS_LIVE_TEST_POSTGRES_URL=postgres://USER:PASSWORD@127.0.0.1:5432/DISPOSABLE_DB node --test backend/office-focus-live-postgres.test.js
CHROMIUM_EXECUTABLE_PATH=/path/to/chromium node --test --test-name-pattern='publisher|late enrollment|one Office device|shared GPS survives|grid visitor cards' scripts/office-focus-geofence-browser.test.mjs
npm run build --prefix office
node scripts/check-js.cjs
node scripts/check-deployment-security.mjs
```

The PostgreSQL test accepts only a loopback database URL, uses a uniquely named disposable schema, synthetic coordinates and credentials, and cleans up worker processes/schema. The proposed CI workflow makes the real two-process test mandatory in a dedicated PostgreSQL 16 job. The existing Office browser job runs the added browser cases. Full hosted CI must finish successfully before merge or deployment.

## Deployment conditions and remaining limitations

1. **Approval required.** This proposal has not merged, deployed, or changed production storage. Applying the new table/index migration is a production location-sharing infrastructure change and must be included in explicit deployment approval.
2. Every API worker/instance must use the same primary database, schema, Office token, and valid encryption key, and run the corrected backend. The existing deployment configuration must be verified before rollout. No secrets need to be printed or rotated for this proposal.
3. Existing Map sessions cannot be migrated from unknown worker memory. Drain the old API workers, deploy the backend and Office together, and ask active publishers to explicitly restart sharing once. A mixed old/new rollout cannot guarantee session visibility on old workers. Do not silently recreate sessions during rollout or rollback.
4. PostgreSQL availability remains a dependency. During an outage, Office retries, markers still expire, and no stale replica is used. An outage longer than the sharing lease requires explicit restart. Production load/latency and database failover behavior have not been measured by the local tests.
5. A failed revocation request stops local publishing immediately, but cannot promise immediate remote deletion while the API is unreachable. The last accepted fix expires within 25 seconds and the session within 90 seconds of its last accepted update; cleanup runs when storage is reachable. A worker restart alone does not renew either lifetime.
6. Database snapshots/backups follow the existing infrastructure's retention and key policies. Clearing a live row is not erasure from previous encrypted backups. Review this retention consequence before approving the schema change. This proposal does not change backup infrastructure.
7. No production device, GPS session, permission setting, or TestFlight release was used or changed. Browser background suspension and OS location permissions still apply.

Design reference: [PostgreSQL explicit locking](https://www.postgresql.org/docs/16/explicit-locking.html), including transaction-level advisory locks and row-lock behavior.
