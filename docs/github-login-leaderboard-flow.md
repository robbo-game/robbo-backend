# GitHub OAuth i leaderboard czasu/śmierci — flow i wdrożenie

Repozytorium: https://github.com/robbo-game/robbo-backend
Gra: https://robbo-game.github.io/robbo/
Punkt wyjścia: https://github.com/robbo-game/robbo/discussions/34

## Cel i punktacja

Dobrowolne konto GitHub identyfikuje gracza. Zalogowany gracz zgłasza wynik do
publicznego rankingu; sam login nie publikuje pustego wyniku. Gra działa offline.
Ranking jest osobny dla kampanii/planety/wersji silnika/hashu kampanii.
Krótszy czas wygrywa, a przy równym czasie mniej śmierci. Remis obu wartości
rozstrzyga stabilny userId wyłącznie dla deterministycznej kolejności.
Backend odtwarza replay i wylicza obie wartości; zachowuje jeden najlepszy wynik
każdego gracza na tablicy. Nie przyjmuje gotowej punktacji klienta.

## Pełny flow logowania

1. „Zaloguj przez GitHub” prowadzi przeglądarkę do `GET {PUBLIC_URL}/auth/github`.
2. Backend tworzy losowy state i verifier PKCE. Verifier zapisuje pod hashem state
   w Redisie na 10 minut, state w oddzielnym cookie HttpOnly/SameSite=Lax.
3. Przekierowuje do GitHub OAuth z client_id, stałym redirect_uri, read:user,
   state, code_challenge i S256. Nie żąda dostępu do repozytoriów ani emaila.
4. GitHub pyta o zgodę i wraca na `/auth/github/callback?code=...&state=...`.
5. Backend porównuje cookie/state i atomowo konsumuje state w Redisie.
   Brak, wygaśnięcie, ponowienie lub odmowa zgody kończą się bez utworzenia sesji.
6. Backend wymienia code z client_secret i verifierem na token, odczytuje `/user`
   i łączy konto po niezmiennym liczbowym GitHub ID. Aktualizuje publiczny login.
7. Tworzy własny Robbo userId i losową sesję na 7 dni. Redis przechowuje hash
   identyfikatora sesji i userId. Poprzednia sesja przeglądarki jest odwoływana.
   Token GitHuba istnieje wyłącznie w pamięci podczas loginu; nie trafia do bazy
   ani klienta. Nie zapisujemy emaila.
8. Ustawia host-only cookie HttpOnly, produkcyjnie Secure/SameSite=None,
   lokalnie SameSite=Lax. Przekierowuje na stałe FRONTEND_URL; nie ma open redirect.
   Klient pobiera `/v1/me` z `credentials: 'include'`.
9. Chronione endpointy odczytują sesję. Mutacje wymagają jawnie dozwolonego Origin,
   CORS stosuje allowlistę. Request logs pomijają query, cookie i authorization.
10. `POST /v1/auth/logout` usuwa sesję w Redisie i cookie. Po TTL wymagany ponowny
    login. Brak sesji/usługi nie blokuje lokalnej gry.

## Flow wyniku i dostarczania leaderboardu

1. Klient nagrywa zwykłe akcje silnika od początku świeżej planety. Przed wysłaniem
   informuje, że login GitHub i wynik staną się publiczne.
2. Zalogowany klient wysyła `{replay: ...}` na `POST /v1/leaderboard/submissions`.
   Odpowiedź 202 zawiera ID/status. SHA-256 deduplikuje ten sam replay tego samego
   użytkownika. Limit: 8 MiB i 10 zgłoszeń/minutę/konto.
3. PostgreSQL przechowuje trwałą kolejkę. Proces `npm run worker` zajmuje zadanie
   przez SKIP LOCKED i lease. Wygasłe lease są odzyskiwane; maksymalnie trzy próby
   po problemach procesu/bazy.
4. Oddzielny worker thread (128 MiB, 10 s timeout) odtwarza przypięty silnik i
   kanoniczne kampanie. Sprawdza wersję, hash, seed, zakresy, każdą akcję,
   checkpoint i hash zdarzeń. Nieukończone/zmienione replaye są odrzucane.
5. Czas to liczba klatek do pierwszego zwycięstwa na tej planecie * 100 ms.
   Obejmuje zapisane pauzy i prezentację śmierci. Śmierci i ręczne restarty/retry
   liczą się jako stracone próby. Restart nie zeruje sumy. Dalsze klatki są
   walidowane, ale nie wpływają na wynik pierwszej planety.
6. Wynik i status verified są publikowane transakcyjnie w PostgreSQL. Gorszy
   wynik nie zastąpi rekordu osobistego. Status rejected nie trafia do rankingu.
7. `GET /v1/leaderboard/submissions/{id}` jest dostępny tylko właścicielowi.
8. Publiczne `GET /v1/leaderboards` podaje obsługiwane tablice i hashe.
   `GET /v1/leaderboards/{campaign}/{planet}?engine=...&campaignHash=...&limit=25&offset=0`
   zwraca rank, userId, displayName, elapsedMs, deaths (do 100 wpisów/stronę).
9. Redis przechowuje niemodyfikowane snapshoty sorted set. TTL wskaźnika wynosi
   15 s; brak cache uruchamia odbudowę z PostgreSQL. Awaria cache nie usuwa wyników,
   odczyt przechodzi na PostgreSQL. Sesje/OAuth nadal wymagają Redisa.

Śmierci dotyczą konkretnego nagrania, nie całej historii użytkownika ani prób,
których nie przesłał. Replay potwierdza poprawną symulację, nie czas rzeczywisty
ani grę człowieka. Serwerowe rozpoczęcie sesji rankingowej jest przyszłym
rozszerzeniem. Wersje silnika i kampanii nigdy nie są mieszane w jednym rankingu.

## Konfiguracja i użycie

Node.js 24, PostgreSQL 17, Redis 8. W Bash/WSL:

```sh
git clone https://github.com/robbo-game/robbo-backend.git
cd robbo-backend
cp .env.example .env
npm ci
docker compose up -d
# Poczekaj na gotowość: docker compose exec postgres pg_isready -U robbo
npm run migrate
npm run build
npm start
# W drugim terminalu: npm run worker
```

`.env`: DATABASE_URL, REDIS_URL, PUBLIC_URL, FRONTEND_URL, ALLOWED_ORIGINS,
GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET. Rzeczywistych sekretów nie zapisujemy w Git.
OAuth App należy zarejestrować w GitHub i skonfigurować klucze w środowisku:
callback lokalny `http://127.0.0.1:3000/auth/github/callback`, produkcyjny
`https://<domena-api>/auth/github/callback`. Zalecana osobna aplikacja dla produkcji.
Otwarcie `/auth/github` w przeglądarce rozpoczyna login.

Przykład ze strony klienta po zalogowaniu:

```js
const response = await fetch(`${api}/v1/leaderboard/submissions`, {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ replay })
});
const job = await response.json();
// Odpytuj GET /v1/leaderboard/submissions/{job.id} z credentials do statusu końcowego.
// Następnie pobierz publiczną tablicę; cache może opóźnić widoczność o maks. 15 s.
```

Dla GitHub Pages i API na innej witrynie przeglądarka może blokować cookies
cross-site. Zalecane domeny gry/API pod wspólną domeną lub reverse proxy. Potrzebne
HTTPS, ukrycie query callbacku w logach proxy, trwałość Redisa i backupy PostgreSQL.
Backend nie tworzy automatycznie OAuth App i nie dodaje UI do repozytorium gry.

## Testy i pozostałe kroki wdrożenia

- [x] OAuth state/PKCE, tożsamość GitHub, sesje/logout i uwierzytelnione API.
- [x] Migracje PostgreSQL, Redis TTL i rate limits OAuth/submissions.
- [x] Kolejka, izolowana weryfikacja silnikiem i najlepsze wyniki.
- [x] Publiczne API leaderboardu i cache sorted set.
- [x] Testy OAuth ze stubem GitHuba, CSRF, replayów, czasu/śmierci i restartów.
- [x] Test integracyjny PostgreSQL/Redis i konfiguracja CI z tymi usługami.
- [ ] Rejestracja OAuth App, ustawienie sekretów i domen środowiska.
- [ ] Wdrożenie API/workera/baz i test rzeczywistego loginu GitHub.
- [ ] UI logowania, nagrywania/wysyłania i leaderboardu w repo gry.
- [ ] Retencja poprawnych replayów, usuwanie/eksport konta, monitoring, backupy
      i test odtworzenia przed publicznym uruchomieniem.

`npm test` wykonuje build i testy. Test integracyjny uruchamia się po ustawieniu
TEST_DATABASE_URL i TEST_REDIS_URL; CI dostarcza osobne usługi testowe.

Dokumentacja GitHuba:
https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
