# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Ksinito is a real-time multiplayer online casino (European roulette + blackjack) using play-money credits. Node.js + Express 5 + Socket.IO on the server; on the client, Bootstrap 5 (CSS + JS bundle) with plain JS modules and no build step. All user-facing text, code comments and error messages are in **Spanish** — keep it that way.

## Commands

```bash
npm install
npm start      # http://localhost:3000
npm run dev    # same, with node --watch auto-restart
```

- Requires Node.js >= 22.13: persistence uses the built-in `node:sqlite` (`DatabaseSync`), not a native npm module. The `--disable-warning=ExperimentalWarning` flag in the scripts silences its warning.
- There is no test suite, linter, or build step. `socket.io-client` is a devDependency for ad-hoc scripted clients (connect with a `ksid` session cookie obtained from `/api/login`).
- Env vars: `PORT`, `DATA_DIR` (default `./data`, DB file `casino.db`), `JWT_SECRET` (≥32 chars; if unset one is generated into `DATA_DIR/jwt-secret`), `COOKIE_SECURE=1` (HTTPS), `TRUST_PROXY` (behind nginx etc.). Delete `data/` to reset all state.
- Accounts only survive redeploys if `DATA_DIR` is on a persistent volume. JWT keeps sessions valid across restarts, but it cannot bring back a wiped `users` table.

## Architecture

### Security model: server-authoritative credits
The core invariant: **the client only sends intents; the server validates everything and is the only thing that can create credits.** Preserve this when changing anything.

- `src/wallet.js` is the **only** module that mutates `users.credits`. Every change goes through `debit`/`credit`/`grantWelcomeBonus`, which run in a transaction and write a row to the `ledger` table (reason strings like `roulette:bet:<key>`, `blackjack:double`). `debit` returns `null` on insufficient funds (the SQL `WHERE credits >= ?` guard + `CHECK (credits >= 0)`), which games translate into a `GameError`.
- Never add an HTTP endpoint or socket event that adds credits. Credits only enter via the one-time welcome bonus (guarded by `welcome_bonus_granted`) or game payouts computed server-side.
- Randomness uses `crypto.randomInt`. The dealer's hole card is replaced by `null` in `BlackjackTable.publicState()` until revealed — never send hidden state to clients.
- `wallet.events` emits `'balance'`; `server.js` forwards it to the `user:<id>` room so all tabs of a user update.

### Server (`src/`)
- `server.js` — wires Express (security headers/CSP, `/api` auth router, static `public/`) and Socket.IO (same-origin check, cookie-based socket auth). All game socket events are registered via the local `on(event, handler)` wrapper, which applies a per-socket token-bucket rate limit and converts exceptions into acks `{ ok, error }`. Only `GameError` messages are shown to players; any other error is logged and returned as `'Error interno'`. Also manages the 20 s grace period before a disconnected user loses their blackjack seat (counted across multiple tabs).
- `errors.js` — `GameError` (player-safe message) and `assertInt` for validating client payload numbers.
- `auth.js` — register/login/logout/me under `/api`. Sessions are stateless HS256 JWTs (`jsonwebtoken`) in the httpOnly cookie `ksjwt`, 7-day TTL, re-issued by `/api/me` once older than a day. `verifyToken` also loads the user and requires the `ca` claim to equal `users.created_at`, so a token can't authenticate as a different account that reused the same id after a DB wipe. Logout only clears the cookie; there is no server-side revocation. Welcome bonus is granted in `loginResponse`. In-memory per-IP rate limiting.
- `avatars.js` + `profile.js` — profile photos. `PUT /api/avatar` takes the raw image body (the client has already cropped it to 256×256 WebP/JPEG). `avatars.imageInfo` checks the format from magic bytes (JPEG/PNG/WebP only) and parses the dimensions from the headers, capping them at 1024 px so other players' browsers can't be made to decode huge images. Photos are BLOBs in the `avatars` table. `GET /api/avatar/:id?v=<updated_at>` is public and immutable-cached. `avatarUrl()` caches versions in memory because `BlackjackTable.publicState()` calls it on every broadcast. `avatars.events` `'change'` makes `server.js` emit `profile` to the user's tabs and re-broadcast the table if they're seated.
- `db.js` — schema (`users`, `ledger`, `roulette_spins`, `avatars`; the old `sessions` table is dropped) created with `CREATE TABLE IF NOT EXISTS` at startup (no migration system) and a `transaction(fn)` helper (`BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`).
- `roulette.js` — `RouletteGame`: one global shared round loop driven by timers (`betting` 20 s → `spinning` 7 s → `result` 5 s). Bets are debited immediately on placement and held in memory (`Map` userId → Map of spots); `settle()` pays winners. Bet types are declared in the `BET_TYPES` table (`payout` = profit per credit; stake is returned on top). Only the last 30 spins are persisted.
- `blackjack.js` — `BlackjackTable`: one 15-seat table (seat count is a constructor option). `server.js` creates `BLACKJACK_TABLES` (5) of them in a `Map` keyed by id 1–5. A user may sit at only one table at a time (`tableOf(userId)`), so `bj:bet`/`bj:action`/`bj:leave` resolve the table from the seat and take no table id. Each table's `broadcast()` calls `onChange`, which drives a debounced `bj:lobby` summary sent to everyone. `settle()` also emits a private `bj:outcome` to each player so the win animation fires even when they're watching another table. Dealing speeds up with many players (`DEAL_TOTAL_MS`). State machine: `waiting → betting → dealing → playing → dealer → settled → waiting`. All progression is timer-driven through `schedule()`/`clearSchedule()` (a single `this.timer`), with `broadcast()` after each step so cards are dealt one at a time. `advance()` finds the next unfinished hand and sets a turn timeout (auto-stand). Leaving mid-hand marks the seat `leaving` and frees it at `resetRound()`; leaving before cards are dealt refunds the bet.

All game state other than balances, sessions and roulette history lives in memory and is lost on restart (in-flight bets already debited are not refunded on crash).

### Socket protocol
- Client → server (with ack callback): `roulette:bet {type, value, amount}`, `roulette:clear`, `bj:watch {table}` (switch the watched table; the socket joins only that table's room), `bj:sit {table, seat}`, `bj:leave`, `bj:bet {amount}`, `bj:action {action: hit|stand|double|split}`.
- Server → client: `balance`, `profile` ({ avatar }), `roulette:state`, `roulette:bets`, `roulette:outcome`, `bj:state` (includes the table `id`/`name`; the client ignores states from tables it isn't watching), `bj:lobby` (per-table `{id, name, seats, occupants, phase}`), `bj:outcome` (private). State events carry the full public snapshot (not diffs), including `endsIn` and `duration` (ms of the current timed phase) for countdowns and progress bars.
- Rooms: `user:<id>`, `roulette`, `bj:<tableId>`. Sockets join a `bj:` room only through `bj:watch`/`bj:sit`, and the client re-sends `bj:watch` on every (re)connect.

### Client (`public/`)
Production sits behind Cloudflare, which lets browsers cache `.css`/`.js` for 4 h. To stop old assets from being paired with a new `index.html` after a deploy, `server.js` serves `index.html` itself (`Cache-Control: no-cache`). At startup it appends `?v=<hash of public/ + dependency versions>` to every `/css`, `/js` and `/vendor` URL. New assets referenced from `index.html` must use those path prefixes to be versioned.

Client libraries (Bootstrap, Bootstrap Icons, `@fontsource` Inter/Cinzel, `canvas-confetti`) are npm dependencies served by `server.js` under `/vendor/...` from `node_modules`. The CSP only allows `'self'`, so never link a CDN; add a package and a `/vendor` route instead. `canvas-confetti` must be created with `useWorker: false`, because the CSP blocks blob workers.

Plain scripts load in order in `index.html`. `roulette.js` and `blackjack.js` define the globals `window.RouletteUI` / `window.BlackjackUI` (IIFE modules exposing `init(ctx)`). Then `app.js` handles auth, tabs and the socket, and calls both `init`s with a shared `ctx`: `socket`, `emit` (promise wrapper with a 5 s timeout), `toast` (Bootstrap Toasts), `celebrate({ amount, net, detail, big })` (queued centre-screen win announcement: "¡Ganaste!" when net > 0, "¡Acertaste!" otherwise; confetti only when net > 0), `avatar(name, url)` (photo, or the initial on a per-name hue), `renderChips`, `reducedMotion`, `user`. Roulette calls `celebrate` whenever the payout is > 0, and blackjack whenever one of your hands wins.

- The roulette wheel is a `<canvas>` with two pre-rendered layers (static bowl, rotating disc) redrawn every frame by a `requestAnimationFrame` loop. The wheel idles slowly. During a spin the ball's path is computed so it lands in the server-chosen pocket (`startSpin`/`ballDuringSpin`).
- Blackjack keeps persistent per-hand card containers (`cardWraps`), so only newly dealt or flipped cards animate when a full snapshot arrives. Per-render animations go through `animQueue`/`runAnimations`.
- The theme lives in `css/style.css` and overrides Bootstrap's `--bs-*` variables (`data-bs-theme="dark"`). Playing cards use `.pcard` and compact hands use `.compact`, because Bootstrap already defines `.card` and `.small`. Animations respect `prefers-reduced-motion`.

Game constants (limits, timings, rules) live at the top of each server game module; the client receives limits via the state payload, but some rules are duplicated client-side for display (e.g. `RED` numbers, `rankValue`), so update both sides together.
