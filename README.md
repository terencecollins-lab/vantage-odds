# Vantage

A dashboard that compares real sportsbook odds across bookmakers for a chosen league (NFL/NBA/MLB/NHL), flags lines that pay better than the no-vig "fair" price as value edges, and shows a player prop's recent-form context (last 5, last 10, all available seasons, and head-to-head).

Odds data comes from the [SportsGameOdds](https://sportsgameodds.com) API. Vantage does not accept wagers, hold funds, or process payments — it's a read-only comparison layer. Sportsbook links open the bookmaker's own site/app.

## Architecture

- `server.py` — stdlib-only Python server. Serves the static frontend and exposes two endpoints, both backed by SportsGameOdds with the API key kept server-side (from `.env`, never sent to the browser):
  - `/api/markets?league=NFL` — fetches + normalizes upcoming odds into card view-models (best price, fair odds, edge %, per-bookmaker rows). Cached 20s.
  - `/api/game-log?league=...&teamID=...&playerID=...&statID=...&opponentTeamID=...` — paginates through every finalized game SportsGameOdds has for that team (the API caps each page at 50, so this walks the `cursor` until exhausted), extracts the player's stat line per game, and returns full history + head-to-head splits + a `coverage` block (earliest date scanned, games found). Cached 24h since finalized results don't change.
- `odds.js` — thin fetch client for both endpoints; no parsing logic duplicated here.
- `sample-odds.js` — static fallback data (clearly fake) shown only if the live feed errors out.
- `app.js` / `index.html` / `style.css` — UI: league + market-type filters, sort, card grid, detail modal (bookmaker table + recent-form section), watchlist, theme toggle.

## Setup

Create `.env` in this folder (gitignored) with your own key:

```
SPORTSGAMEODDS_API_KEY=your_key_here
```

## Run locally

```bash
python3 server.py
```

Then open http://localhost:5173

## Deploy to Render (free)

This is what lets the [VantageIOS](../VantageIOS) app work on a real device, since a physical phone can't reach your Mac's `localhost`. Render's free tier needs no credit card, stays deployed indefinitely, and gives you a free HTTPS URL (cold starts after ~15 min idle — the first request after that takes 30-50s).

1. Push this `Vantage` folder to a GitHub repo (public or private — either works with Render).
2. In the [Render dashboard](https://dashboard.render.com), New → Web Service → connect that repo. Render should auto-detect `render.yaml` (already in this folder) and pre-fill the build/start commands.
3. Under Environment, add `SPORTSGAMEODDS_API_KEY` with your key — this replaces the local `.env` file, which never gets committed.
4. Deploy. Once it's live, note the `https://<something>.onrender.com` URL — that's both the web dashboard (now public) and the API the iOS app should point at.

Since this makes the API-comparison proxy reachable by anyone with the URL (not just you), keep in mind it draws against your own SportsGameOdds quota if someone else finds and hits it. There's no auth on it currently — add some (a shared-secret header, for instance) if that's a concern for your key's rate limits.

## Notes / limitations

- Only full-game Moneyline, Spread, and Total markets get a per-bookmaker comparison table — that's what's available on the free/base API tier. Player props are included too, but only as a single "Consensus" line (no per-book breakdown at this tier), plus the recent-form section described below.
- **Historical depth**: SportsGameOdds' finalized-game history only goes back to roughly February 2024 for every league checked (NFL/NBA/MLB/NHL) — about 2 seasons, not 5. The game-log endpoint pages through and returns everything available; the UI's coverage note says exactly how far back it actually found data, rather than silently showing less than the full history.
- "Edge vs. fair odds" is a simple decimal-odds delta against the API's no-vig consensus line — an informational estimate, not a guarantee of value.
- If you plan to deploy this somewhere others can reach, add real age/region gating and check SportsGameOdds' and each sportsbook's terms of use for redistribution/display restrictions first — this build has neither and is meant for local/personal use.
