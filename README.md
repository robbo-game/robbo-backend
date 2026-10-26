# robbo-backend

Optional GitHub login, cross-device game checkpoints, progress storage and verified per-planet leaderboards for [Robbo](https://robbo-game.github.io/robbo/). The browser game remains fully playable offline.

See [the complete OAuth and leaderboard flow](docs/github-login-leaderboard-flow.md) for setup, API usage, ranking rules and rollout steps.

## Funkcjonalność uzgodniona w projekcie

Backend jest niezależną usługą dla [gry Robbo](https://robbo-game.github.io/robbo/).
Założenia pochodzą z [dyskusji #34](https://github.com/robbo-game/robbo/discussions/34);
pełny flow logowania i rankingu opisuje [issue #1](https://github.com/robbo-game/robbo-backend/issues/1).

| Funkcja | Obecne zachowanie backendu |
| --- | --- |
| Gra bez konta | Lokalna rozgrywka nie wymaga API; konto jest opcjonalne |
| Logowanie GitHub | OAuth authorization code + PKCE, własny userId Robbo i sesja Redis |
| Synchronizacja postępu | Prywatne rekordy kampanii/slotu w PostgreSQL, rewizje i wykrywanie konfliktów |
| Przeniesienie rozgrywki telefon → komputer | Pełny checkpoint SavedAttempt, prywatny zapis/odczyt przez oba urządzenia zalogowane na to samo konto |
| Ranking | Osobno dla kampanii, planety, silnika i hashu kampanii; krótszy czas, potem mniej śmierci |
| Potwierdzanie wyników | Serwer odtwarza replay; wynik podany przez klienta nie jest uznawany za wiarygodny |
| Dostarczanie rankingu | Publiczne REST API z paginacją, prywatny status zgłoszenia, Redis sorted sets jako cache |
| Trwałość danych | PostgreSQL jest źródłem prawdy; utrata cache Redisa nie usuwa postępu ani wyników |
| Prywatność | Checkpointy i postęp widzi tylko właściciel; publiczny ranking zawiera pseudonim i wynik |

Kod backendu obsługuje powyższe operacje. Uruchomienie funkcji w samej grze wymaga
wdrożenia usługi, konfiguracji GitHub OAuth App oraz podłączenia klienta gry do API.
To repozytorium nie wdraża automatycznie serwera ani przycisków synchronizacji
na GitHub Pages. Magic link, eksport/usuwanie konta i pełna obsługa konfliktów
w interfejsie gracza pozostają kolejnymi etapami.

## Pauza na telefonie i wznowienie na komputerze

Checkpoint jest czymś innym niż postęp kampanii i replay rankingu. Zawiera format
`SavedAttempt` używany przez grę: wersję silnika i hash kampanii, planetę, seed,
bieżący stan RNG oraz kompletny snapshot świata. Zachowuje pozycje i stany obiektów,
Robbo, klucze, amunicję, zebrane/pozostałe śruby, licznik klatek, pociski, eksplozje,
lasery, teleportację i stan prezentacji śmierci. Odczyt przez `restoreAttempt`
przywraca grę w pauzie, aby przeciwnicy nie ruszyli przed naciśnięciem „Wznów”.
Układ ekranu, sterowanie dotykowe, dźwięki już odtworzone i oczekujące naciśnięcia
klawiszy nie są przenoszone — komputer korzysta ze swojego interfejsu.

Flow integracji klienta:

1. Na obu urządzeniach gracz loguje się tym samym kontem GitHub.
2. Klient pobiera `GET /v1/checkpoints/{campaign}/current`. Odpowiedź zawiera
   `revision` i `ETag`; brak zapisu daje 404 z revision 0. Na nowym urządzeniu nie
   należy nadpisywać chmury przed sprawdzeniem istniejącego checkpointu.
3. Po pauzie telefon najpierw zapisuje lokalnie, a następnie wysyła
   `PUT /v1/checkpoints/{campaign}/current` z `deviceId`, `attempt`, `If-Match`
   i unikalnym `Idempotency-Key`. Checkpoint jest sprawdzany w izolowanym workerze
   przez odtworzenie stanu przypiętym silnikiem. Nieobsługiwana wersja lub uszkodzone
   referencje obiektów dają 422.
4. Dopiero odpowiedź 200 potwierdza zapis w chmurze. Komputer pobiera checkpoint,
   wywołuje `restoreAttempt(record.attempt, packs)` i pokazuje „Wznów”.
5. Wznowienie wywołuje `session.togglePause()` i kontynuuje identyczną symulację
   z zachowanym stanem losowości. Następne zapisy używają pobranej rewizji.
6. Gdy drugi klient zdąży zapisać nowszy stan, PUT zwraca 412 z aktualnym rekordem.
   Klient zachowuje własny zapis lokalny i daje wybór: pobierz chmurę albo świadomie
   nadpisz po ponownym pobraniu rewizji. Nie ponawia automatycznie z nową rewizją.

Przykład kodu klienta (korzysta z funkcji `saveAttempt`/`restoreAttempt` silnika gry):

```js
// api: skonfigurowany adres API; session: aktualna sesja gry.
// revision: rewizja pobrana wcześniej z chmury (0 tylko dla nieistniejącego slotu).
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
// Przy błędzie sieci ponów dokładnie to samo żądanie i requestId.
// Przy 412 pokaż konflikt; przy 401 zaloguj ponownie.
if (!response.ok) throw new Error(`Checkpoint save: ${response.status}`);
const saved = await response.json();
revision = saved.revision;

// Na drugim urządzeniu, po zalogowaniu:
const downloaded = await fetch(`${api}/v1/checkpoints/${campaign}/current`, {
  credentials: 'include', cache: 'no-store'
});
if (!downloaded.ok) throw new Error(`Checkpoint load: ${downloaded.status}`);
const record = await downloaded.json();
const restored = restoreAttempt(record.attempt, packs); // w pauzie
// Dopiero po kliknięciu „Wznów”: restored.togglePause();
```

`GET` i `PUT` wymagają własnej sesji użytkownika. Żądania przeglądarkowe PUT
wymagają dozwolonego Origin, odpowiedzi są prywatne z Cache-Control: no-store,
a ETag jest udostępniony przez CORS. `deviceId` służy do rozpoznania źródła zapisu,
nie do autoryzacji. Nie podaje się userId w treści żądania.

Zapisy są transakcyjne w PostgreSQL (`game_checkpoint`, `checkpoint_history`,
`checkpoint_request`): aktualny rekord, pięć ostatnich wersji na slot oraz historia
idempotencji (do 50 ostatnich żądań użytkownika, maksymalnie 7 dni). Ta sama treść
z tym samym kluczem nie zwiększa rewizji; inna treść z użytym kluczem daje 409.
Nieistniejący slot można utworzyć tylko z If-Match 0. Dwa równoczesne zapisy tej
samej rewizji nie mogą oba wygrać. Limit: 1 MiB na zapis, 30 zapisów/minutę/konto,
20 slotów na konto. Redis nie jest kopią checkpointów: nie zwróci przestarzałego
stanu po zmianie urządzenia. Dostęp wymaga jednak aktywnej sesji przechowywanej w Redisie.

Pauza offline pozostaje lokalna. Zamknięcie aplikacji w telefonie nie gwarantuje
ukończenia żądania sieciowego; klient powinien pokazywać „zapisano w chmurze” dopiero
po potwierdzeniu, zachować lokalny journal i ponowić wysyłkę po powrocie połączenia.
Checkpoint jest zapisem do kontynuacji, nie dowodem wyniku: nie tworzy ani nie
podnosi pozycji w leaderboardzie. Ranking nadal wymaga zweryfikowanego replaya.

## What is implemented

- Fastify REST API, strict JSON schemas, 256 KiB request cap and allow-list CORS.
- GitHub OAuth (`GET /auth/github`, callback), state + PKCE, stable GitHub account linking, opaque seven-day Redis sessions, `GET /v1/me`, server-side logout and `/healthz`.
- Versioned progress: `GET /v1/progress?since=<ISO timestamp>` and `PUT /v1/progress/{campaign}/{slot}` with `If-Match` optimistic concurrency and an `Idempotency-Key`.
- Private full game checkpoints: `GET/PUT /v1/checkpoints/{campaign}/{slot}`, validated against the pinned engine, with transactional revision checks, retry deduplication and five-version history.
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
