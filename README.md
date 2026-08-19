# Vantage

A dashboard that compares real sportsbook odds across bookmakers for a chosen league (NFL/NBA/MLB/NHL) and flags lines that pay better than the no-vig "fair" price as value edges.

Odds data comes from the [SportsGameOdds](https://sportsgameodds.com) API. Vantage does not accept wagers, hold funds, or process payments — it's a read-only comparison layer. Sportsbook links open the bookmaker's own site/app.

## Architecture

- `server.py` — stdlib-only Python server. Serves the static frontend and proxies `/api/events` to SportsGameOdds, attaching the API key server-side (from `.env`, never sent to the browser) and caching responses for 20s.
- `odds.js` — fetches from `/api/events` and normalizes the response into card view-models (best price, fair odds, edge %, per-bookmaker rows).
- `sample-odds.js` — static fallback data (clearly fake) shown only if the live feed errors out.
- `app.js` / `index.html` / `style.css` — UI: league + market-type filters, sort, card grid, detail modal, watchlist, theme toggle.

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

## Notes / limitations

- Only full-game Moneyline, Spread, and Total markets are shown — these are the markets with per-bookmaker odds on the free/base API tier. Player props are returned by the API but without a per-bookmaker breakdown at this tier (only a blended "fair" line), so they're excluded from the comparison view for now.
- "Edge vs. fair odds" is a simple decimal-odds delta against the API's no-vig consensus line — an informational estimate, not a guarantee of value.
- If you plan to deploy this somewhere others can reach, add real age/region gating and check SportsGameOdds' and each sportsbook's terms of use for redistribution/display restrictions first — this build has neither and is meant for local/personal use.
