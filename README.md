# robbo-backend

Optional GitHub login, progress storage and verified per-planet leaderboards for [Robbo](https://robbo-game.github.io/robbo/). The browser game remains fully playable offline.

See [the complete OAuth and leaderboard flow](docs/github-login-leaderboard-flow.md) for setup, API usage, ranking rules and rollout steps.

## What is implemented

- Fastify REST API, strict JSON schemas, 256 KiB request cap and allow-list CORS.
- GitHub OAuth (`GET /auth/github`, callback), state + PKCE, stable GitHub account linking, opaque seven-day Redis sessions, `GET /v1/me`, server-side logout and `/healthz`.
- Versioned progress: `GET /v1/progress?since=<ISO timestamp>` and `PUT /v1/progress/{campaign}/{slot}` with `If-Match` optimistic concurrency and an `Idempotency-Key`.
- PostgreSQL stores canonical users, progress, queued submissions and verified personal bests; Redis stores sessions, one-time OAuth state, rate limits and sorted-set leaderboard cache snapshots.
- `POST /v1/leaderboard/submissions` accepts an authenticated `{replay: ...}` and returns a queued job. `GET /v1/leaderboard/submissions/{id}` is owner-only.
- `GET /v1/leaderboards` lists supported boards; `GET /v1/leaderboards/{campaign}/{planet}?engine=...&campaignHash=...&limit=25&offset=0` returns public verified entries.
- A separate worker reproduces the pinned game engine in a thread with memory/time limits. Each player has one best result per campaign/planet/engine/hash: shorter simulated time wins, fewer deaths break time ties, stable user ID resolves exact ties. Tick duration is 100 ms; pauses/death sequences count, restarts do not reset totals. Only deaths within the submitted recording count, not lifetime attempts. The first win fixes the score; trailing frames are still validated.

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
