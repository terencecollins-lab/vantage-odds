# Vantage

A dashboard that compares real sportsbook odds across bookmakers for a chosen league, flags lines that pay better than the no-vig "fair" price as value edges, and shows recent-form context for both player props (last 5, last 10, all available seasons, head-to-head) and team markets (Moneyline win/loss, Spread cover rate, Total over/under history). Cards show a "History since {date}" badge with the real earliest-data date for that league — not a marketing claim, an actual computed value. A separate "MLB Matchups" tab shows real batter-vs-pitcher career history for each game's probable starters, and a "Best No-Vig" tab ranks the best value edges across every supported league at once, auto-refreshing every 30s.

**Supported leagues** (41, grouped by sport — see `odds.js`'s `LEAGUE_GROUPS`): Football (NFL, College Football, CFL, USFL, XFL), Basketball (NBA, College Basketball, WNBA, NBA G League), Baseball (MLB, NPB, KBO, CPBL, MLB Minors/AAA, WBC, LBPRC, LIDOM, LMP, LVBP), Hockey (NHL, AHL, KHL, SHL), Soccer (Premier League, Champions League, Europa League, La Liga, Bundesliga, Serie A, Ligue 1, MLS, Brasileiro Série A, Liga MX, International Soccer), Handball (EHF European League, EHF European Cup, SEHA Liga, IHF Super Globe), Tennis (ATP, WTA), MMA (UFC). Golf (PGA, LIV) and SportsGameOdds' NON_SPORTS categories (Politics, TV, Movies, Music, Fun, Events, Weather, Markets) are deliberately excluded — those are outright/prop formats with no home/away pairing, which this app's "Team A @ Team B" card model can't represent without a different UI.

Odds data comes from the [SportsGameOdds](https://sportsgameodds.com) API. Batter/pitcher matchup data comes from [MLB's own public Stats API](https://statsapi.mlb.com) (the same one MLB.com's stat pages use — unauthenticated, no key needed). Vantage does not accept wagers, hold funds, or process payments — it's a read-only comparison layer. Sportsbook links open the bookmaker's own site/app.

## Architecture

- `server.py` — stdlib-only Python server. Serves the static frontend and exposes:
  - `/api/markets?league=NFL` — fetches + normalizes upcoming odds into card view-models (best price, fair odds, edge %, no-vig probability, per-bookmaker rows). Cached 20s.
  - `/api/game-log?league=...&teamID=...&statID=...&opponentTeamID=...&playerID=` — paginates through every finalized game SportsGameOdds has for that team (the API caps each page at 50, so this walks the `cursor` until exhausted). With `playerID`, extracts that player's stat line per game; without it, `statID` must be one of `team_win`/`team_margin`/`game_total`, computed from the team's own scoring. Returns full history + head-to-head splits + a `coverage` block. Cached 24h since finalized results don't change.
  - `/api/mlb-matchups?homeTeamID=...&awayTeamID=...&gameDate=YYYY-MM-DD` — looks up that game's probable starting pitchers via MLB's schedule endpoint, pulls each opposing team's active-roster hitters, and fetches each hitter's career at-bat history against that specific pitcher (MLB's `vsPlayer` split), aggregating the raw counting stats across seasons into one lifetime AVG/OBP/SLG/OPS line (rate stats aren't valid to average directly — only the underlying counts are). Fetches run in parallel via a thread pool since a full lineup is 10-15 independent calls. Cached: schedule/probable-pitcher lookups 2h, rosters 24h, matchup history 24h.
  - `/api/best-no-vig` — fetches all four leagues in parallel, ranks by edge % (excluding an upper sanity cap that filters out illiquid/rare-prop artifacts like "Triples Over 0.5" showing a nonsensical +600% "edge"), and takes each league's own top slice before a final combined sort — otherwise MLB's far higher prop volume floods out the other three leagues entirely. Reuses the same 20s-cached per-league fetch `/api/markets` uses.
  - Both external APIs are called with a real browser `User-Agent` — Cloudflare (in front of SportsGameOdds) and other bot-protection blocks the default Python/curl UA string outright.
- `odds.js` / `mlb.js` — thin fetch clients; no parsing logic duplicated here.
- `sample-odds.js` — static fallback data (clearly fake) shown only if the live feed errors out.
- `app.js` / `index.html` / `style.css` — UI: a Markets/Best No-Vig/MLB Matchups tab toggle, league + market-type + sportsbook + stat-type filters, sort, card grid, detail modal (bookmaker table + no-vig + recent-form section), watchlist, theme toggle.

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

- **API tier matters a lot here.** On SportsGameOdds' free tier, player props had no per-bookmaker breakdown (consensus line only) and only ~9 sportsbooks appeared anywhere. On `pro`, both of those limits disappear — 40+ books show up, including DFS-style sources like **PrizePicks** and **Novig**, and props get real per-book comparisons.
- **Per-book lines can genuinely differ**, not just prices — PrizePicks especially often posts a materially different total than sportsbooks for "the same" prop (e.g. Over 92.5 vs. Over 149.5 passing yards). Comparing raw odds across different lines would be comparing different bets, so each bookmaker row carries its own `line`/`onLine` flag: only books quoting the *same* line as the consensus are eligible to be "best price," and any book quoting a different line is shown but visually faded, with its line called out, so it's transparent rather than silently misleading.
- Only full-game Moneyline, Spread, and Total markets get a per-bookmaker comparison table on lower tiers — check `/api/account/usage` (via your key) if odds look sparse; it tells you your exact tier and quota.
- **Historical depth**: SportsGameOdds' finalized-game history only goes back to roughly February 2024 for the major US leagues checked (NFL/NBA/MLB/NHL) — about 2 seasons, not 5. Smaller/international leagues may have shallower history still. The game-log endpoint pages through and returns everything available; the UI's coverage note says exactly how far back it actually found data, rather than silently showing less than the full history.
- **Off-season and low-volume leagues**: several of the newly added leagues (e.g. WBC, LIV Golf's neighbors in handball like SEHA/IHF Super Globe, the winter baseball leagues LBPRC/LIDOM/LMP/LVBP) only have games — and therefore odds — during their actual season/tournament window. Outside that window, selecting them will correctly show "No live markets match your filters" rather than an error.
- **Soccer/handball moneyline**: those leagues' full-match win/loss line lives under a different API period (`reg`, regulation time) than the American sports' `game` period, and only the 2-way "draw no bet" version is surfaced — not the 3-way (with draw) or double-chance markets, to keep the recent-form/no-vig model consistent across every league without introducing a third outcome everywhere else assumes two.
- "Edge vs. fair odds" is a simple decimal-odds delta against the API's no-vig consensus line — an informational estimate, not a guarantee of value.
- The free tier's monthly quota (2,500 "entities") is easy to burn through during active development — a `pro` key removes that ceiling (unlimited monthly entities, 300 req/min) and is what this build currently uses.
- If you plan to deploy this somewhere others can reach, add real age/region gating and check SportsGameOdds' and each sportsbook's terms of use for redistribution/display restrictions first — this build has neither and is meant for local/personal use.
