# robbo-backend

Backend for the optional cloud layer of Robbo. The browser game remains fully playable offline; this service will later provide account-based progress synchronisation and verified leaderboards.

## What is implemented

- Fastify REST API, strict JSON schemas, 256 KiB request cap and allow-list CORS.
- `GET /healthz`, guest-safe `GET /v1/me`, `POST /v1/auth/logout`.
- Versioned progress: `GET /v1/progress?since=<ISO timestamp>` and `PUT /v1/progress/{campaign}/{slot}` with `If-Match` optimistic concurrency and an `Idempotency-Key`.
- PostgreSQL schema for canonical progress and idempotency responses; Redis is connected at startup so deployment fails fast if its session/rate-limit/leaderboard dependency is unavailable.
- Empty, deliberately non-authoritative leaderboard read endpoint. Replay upload and submission remain disabled until the server-side deterministic replay verifier lands.

Cloud progress endpoints return 401 until a server-side authenticated user resolver is implemented. Contract tests inject an isolated test identity; the running server never uses a shared guest account. GitHub OAuth and magic links require deployment-specific secrets and redirect URLs; no OAuth secrets belong in this repository. This is an initial foundation, not a production-ready authentication or synchronization service.

The credentials in `.env.example` and `compose.yaml` are public development placeholders for local containers only. Database ports bind to loopback. Keep real credentials in an ignored `.env` file or a deployment secret manager. Never reuse the development password in production.

## Run locally

```sh
cp .env.example .env
docker compose up -d
npm install
set -a; . ./.env; set +a
npm run migrate
npm run dev
```

Then call `http://127.0.0.1:3000/healthz`. Run `npm test` for contract tests.

## Deployment order

1. Run the migration against managed PostgreSQL and enable Redis AOF/backups.
2. Set exact production origins in `ALLOWED_ORIGINS`; terminate TLS at the edge.
3. Add GitHub OAuth plus magic-link authentication, session rotation, deletion/export flows and a real user resolver.
4. Integrate client-side sync queue and conflict UX without changing local-first behavior.
5. Add isolated replay verification workers before accepting any leaderboard submission.
