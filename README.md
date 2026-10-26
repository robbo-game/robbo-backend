# robbo-backend

Optional GitHub login, cross-device game checkpoints, progress storage and verified per-planet leaderboards for [Robbo](https://robbo-game.github.io/robbo/). The browser game remains fully playable offline.

See [the complete OAuth and leaderboard flow](docs/github-login-leaderboard-flow.md) for setup, API usage, ranking rules and rollout steps.

## Project functionality

The backend is an independent service for [Robbo](https://robbo-game.github.io/robbo/).
The requirements originate in [discussion #34](https://github.com/robbo-game/robbo/discussions/34);
[issue #1](https://github.com/robbo-game/robbo-backend/issues/1) describes the complete login and leaderboard flow.

| Feature | Current backend behavior |
| --- | --- |
| Guest play | Local gameplay does not require the API; accounts are optional |
| GitHub login | OAuth authorization code + PKCE, a separate Robbo userId and a Redis session |
| Progress synchronization | Private campaign/slot records in PostgreSQL, revisions and conflict detection |
| Moving a game from phone to desktop | A full SavedAttempt checkpoint, privately saved and loaded by devices signed into the same account |
| Ranking | Separate boards for each campaign, planet, engine and campaign hash; shorter time, then fewer deaths |
| Result verification | The server replays the recording; client-supplied scores are not trusted |
| Leaderboard delivery | A paginated public REST API, private submission status and Redis sorted-set caching |
| Data durability | PostgreSQL is authoritative; losing the Redis cache does not delete progress or results |
| Privacy | Only the owner can access checkpoints and progress; public entries contain a display name and result |

The backend implements these operations. Enabling them in the game requires
deploying the service, configuring a GitHub OAuth App and connecting the game client to the API.
This repository does not automatically deploy the server or add synchronization controls
to GitHub Pages. Magic links, account export/deletion and full conflict resolution
in the player interface remain future work.

## Pause on a phone and resume on a desktop

A checkpoint is distinct from campaign progress and a leaderboard replay. It uses
the game's `SavedAttempt` format: engine version, campaign hash, planet, seed,
current RNG state and a complete world snapshot. It preserves object positions and states,
Robbo, keys, ammunition, collected/remaining screws, tick count, projectiles, explosions,
lasers, teleportation and death presentation state. Loading through `restoreAttempt`
restores the game paused so enemies cannot move before the player chooses Resume.
Screen layout, touch controls, already-played sounds and pending key presses
are not transferred; the desktop uses its own interface.

Client integration flow:

1. The player signs into the same GitHub account on both devices.
2. The client requests `GET /v1/checkpoints/{campaign}/current`. The response includes
   `revision` and `ETag`; a missing save returns 404 with revision 0. A new device must
   check for an existing checkpoint before overwriting the cloud save.
3. After pausing, the phone saves locally first, then sends
   `PUT /v1/checkpoints/{campaign}/current` with `deviceId`, `attempt`, `If-Match`
   and a unique `Idempotency-Key`. An isolated worker validates the checkpoint
   by restoring it with the pinned engine. Unsupported versions or corrupt
   object references return 422.
4. Only a 200 response confirms the cloud save. The desktop downloads the checkpoint,
   calls `restoreAttempt(record.attempt, packs)` and displays Resume.
5. Resuming calls `session.togglePause()` and continues the same simulation
   with the preserved RNG state. Subsequent saves use the downloaded revision.
6. If another client has saved a newer state, PUT returns 412 with the current record.
   The client keeps its local save and offers a choice: load the cloud save or explicitly
   overwrite it after fetching the latest revision. It must not automatically retry with a new revision.

Client example (using the game engine's `saveAttempt`/`restoreAttempt` functions):

```js
// api: configured API URL; session: current game session.
// revision: previously fetched cloud revision (0 only for a missing slot).
if (!session.paused) session.togglePause();
const attempt = saveAttempt(session);
const requestId = crypto.randomUUID();
const response = await fetch(`${api}/v1/checkpoints/${session.pack.id}/current`, {
  method: 'PUT', credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
    'If-Match': `"${revision}"`,
    'Idempotency-Key': requestId
  },
  body: JSON.stringify({ deviceId: 'phone-device-id', attempt })
});
// On a network failure, retry the exact same request and requestId.
// On 412, display the conflict; on 401, sign in again.
if (!response.ok) throw new Error(`Checkpoint save: ${response.status}`);
const saved = await response.json();
revision = saved.revision;

// On the second device, after signing in:
const downloaded = await fetch(`${api}/v1/checkpoints/${campaign}/current`, {
  credentials: 'include', cache: 'no-store'
});
if (!downloaded.ok) throw new Error(`Checkpoint load: ${downloaded.status}`);
const record = await downloaded.json();
const restored = restoreAttempt(record.attempt, packs); // paused
// Only after the player chooses Resume: restored.togglePause();
```

Both `GET` and `PUT` require the owner's user session. Browser PUT requests
require an allowed Origin, responses are private with Cache-Control: no-store,
and ETag is exposed through CORS. `deviceId` identifies the source device;
it does not authorize access. The request body does not accept a userId.

Writes are transactional in PostgreSQL (`game_checkpoint`, `checkpoint_history`,
`checkpoint_request`): the current record, the five most recent versions per slot and
idempotency history (up to the user's 50 most recent requests, retained for at most seven days).
The same content with the same key does not increment the revision; different content
with a reused key returns 409. A missing slot can only be created with If-Match 0.
Two concurrent writes against the same revision cannot both succeed. Limits: 1 MiB per save,
30 saves/minute/account and 20 slots/account. Redis does not cache checkpoints,
so switching devices does not return a stale cached state. Access still requires
an active session stored in Redis.

Pausing offline only saves locally. Closing the phone app does not guarantee that
a network request completes; the client should display Saved to cloud only after
confirmation, keep its local journal and retry when connectivity returns.
A checkpoint is for resuming gameplay, not proving a result: it does not create
or improve a leaderboard entry. Ranking still requires a verified replay.

## What is implemented

- Fastify REST API, strict JSON schemas, 256 KiB request cap and allow-list CORS.
- GitHub OAuth (`GET /auth/github`, callback), state + PKCE, stable GitHub account linking, opaque seven-day Redis sessions, `GET /v1/me`, server-side logout and `/healthz`.
- Versioned progress: `GET /v1/progress?since=<ISO timestamp>` and `PUT /v1/progress/{campaign}/{slot}` with `If-Match` optimistic concurrency and an `Idempotency-Key`.
- Private full game checkpoints: `GET/PUT /v1/checkpoints/{campaign}/{slot}`, validated against the pinned engine, with transactional revision checks, retry deduplication and five-version history.
- PostgreSQL stores canonical users, progress, queued submissions and verified personal bests; Redis stores sessions, one-time OAuth state, rate limits and sorted-set leaderboard cache snapshots.
- `POST /v1/leaderboard/submissions` accepts an authenticated `{replay: ...}` and returns a queued job. `GET /v1/leaderboard/submissions/{id}` is owner-only.
- `GET /v1/leaderboards` lists supported boards; `GET /v1/leaderboards/{campaign}/{planet}?engine=...&campaignHash=...&limit=25&offset=0` returns public verified entries.
- A separate worker reproduces the pinned game engine in a thread with memory/time limits. Each player has one best result per campaign/planet/engine/hash: shorter simulated time wins, fewer deaths break time ties, stable user ID resolves exact ties. Tick duration is 100 ms; pauses/death sequences count, restarts do not reset totals. Only deaths within the submitted recording count, not lifetime attempts. The first win fixes the score; trailing frames are still validated.

## HTTP API endpoints

These are the application endpoints exposed by the API. Public endpoints do not
require a session; private endpoints require the `robbo_session` cookie obtained
through GitHub login. `/v1/me` and logout also work for guests. All `POST` and
`PUT` requests require an `Origin` header matching a configured allowed origin,
including requests made outside a browser. JSON bodies require `Content-Type:
application/json`. Path parameters are shown in braces.

| Method | Path | Access | Parameters | Purpose |
| --- | --- | --- | --- | --- |
| GET | `/healthz` | Public | None | Returns `{"status":"ok"}` to indicate the API is running. |
| GET | `/auth/github` | Public | None | Starts GitHub OAuth and redirects the browser to GitHub. Requires configured OAuth credentials. |
| GET | `/auth/github/callback` | Public | Query: `state` and `code` on success; GitHub may return `error`. Requires the OAuth state cookie set at login. | Completes GitHub login, creates a session and redirects to the frontend. |
| GET | `/v1/me` | Public | Optional session cookie. | Returns the signed-in user and `account` mode, or a null user and `guest` mode. |
| POST | `/v1/auth/logout` | Public | Allowed `Origin`; optional session cookie. | Deletes the current server-side session and clears its cookie. |
| GET | `/v1/progress` | Session | Optional query `since`: ISO 8601 date-time. | Lists the user's progress records updated after `since`, with a cursor. |
| PUT | `/v1/progress/{campaign}/{slot}` | Session | Path: `campaign`, `slot`. Headers: `If-Match` (unquoted revision), `Idempotency-Key` (16–128 characters), allowed `Origin`. JSON: `schemaVersion` (integer ≥ 1), `gameVersion`, `deviceId`, `payload` (object). | Creates or updates progress with revision checking and retry deduplication. Use revision `0` for a new record. |
| GET | `/v1/checkpoints/{campaign}/{slot}` | Session | Path: `campaign`, `slot`. | Retrieves the user's saved checkpoint and revision, or returns 404 with revision 0 when absent. |
| PUT | `/v1/checkpoints/{campaign}/{slot}` | Session | Path: `campaign`, `slot`. Headers: `If-Match` (quoted or unquoted revision), `Idempotency-Key` (16–128 characters), allowed `Origin`. JSON: `deviceId`, `attempt` (SavedAttempt object). | Validates and saves a checkpoint with revision checking and retry deduplication. Use revision `0` for a new slot. |
| GET | `/v1/leaderboards` | Public | None. | Lists supported boards and their ranking order. |
| GET | `/v1/leaderboards/{campaign}/{planet}` | Public | Path: `campaign`, `planet` (1–9999). Required query: `engine`, `campaignHash` (8 lowercase hexadecimal characters). Optional query: `limit` (1–100, default 25), `offset` (0–10000, default 0). | Returns a page of verified results for a supported board. |
| POST | `/v1/leaderboard/submissions` | Session | Allowed `Origin`; JSON: `replay` (object). | Queues a replay for verification and returns its submission information with HTTP 202. |
| GET | `/v1/leaderboard/submissions/{id}` | Session | Path: `id` (submission UUID). | Returns the status of a submission owned by the signed-in user. |

`campaign`, `slot`, and `engine` are 1–64 character identifiers containing
letters, digits, `.`, `_`, or `-`. Browser clients must include credentials for
session requests. The OAuth endpoints are unavailable until GitHub credentials
are configured; the endpoint list does not imply that the service is publicly
deployed.

Cloud writes require a valid Robbo session and an allowed Origin; frontend fetches use `credentials: 'include'`. Public entries include rank, userId, displayName (GitHub login), elapsedMs and deaths. Explain that the login/result become public before offering submission. GitHub tokens are used only during login, never stored or returned. Cookies are host-only/HttpOnly, Secure/SameSite=None over HTTPS (Lax locally); request logs omit query strings and credentials. Register a GitHub OAuth App and set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `PUBLIC_URL` and `FRONTEND_URL` in the environment. Callback: `{PUBLIC_URL}/auth/github/callback`. Missing OAuth configuration returns 503. Magic links are not implemented.

The frontend login/ranking screens and automatic submissions are not yet connected in the game repository. Deploying this repository alone does not enable the UI. Cross-site cookies between GitHub Pages and an unrelated API domain may be blocked; use game/API domains under one site or a same-origin reverse proxy. Only a valid simulation is proven, not human play or wall-clock speed.

The credentials in `.env.example` and `compose.yaml` are public development placeholders for local containers only. Database ports bind to loopback. Keep real credentials in an ignored `.env` file or a deployment secret manager. Never reuse the development password in production.

## Run locally

```sh
cp .env.example .env
docker compose up -d
npm ci
# Wait until PostgreSQL is ready before migration.
npm run migrate
npm run build
npm start
# In a second terminal:
npm run worker
```

Then call `http://127.0.0.1:3000/healthz` or open `/auth/github` to log in. `npm run dev` runs the API with reload after the initial build. Scripts load `.env` if present. Run `npm test` for type checks, OAuth/API and replay tests. Set `TEST_DATABASE_URL` and `TEST_REDIS_URL` for the database integration test; GitHub Actions supplies dedicated services.

## Deployment order

1. Apply migrations to PostgreSQL; provision persistent Redis and backups. Start API and worker as separate supervised processes.
2. Configure OAuth keys, fixed HTTPS URLs and exact production origins; omit OAuth query strings from ingress logs.
3. Connect frontend login, replay submission/status and leaderboard UI. Guests retain offline play.
4. Add account export/deletion, valid-replay retention policies, monitoring and restore tests before launch.

Submissions are limited to 8 MiB and 10/minute/account. Verification accepts at most 100,000 frames and 32 actions/frame, with 128 MiB heap and a 10-second deadline. PostgreSQL jobs recover expired leases up to three attempts. Invalid payloads are removed on rejection; successful replays currently remain for audit. Redis ranking snapshots have up to 15 seconds of staleness and automatically rebuild from PostgreSQL, which also supplies reads during cache failure. Session authentication requires Redis.
