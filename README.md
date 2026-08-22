# Vantage

A dashboard that compares real sportsbook odds across bookmakers for a chosen league, flags lines that pay better than the no-vig "fair" price as value edges, and shows recent-form context for both player props (last 5, last 10, all available seasons, head-to-head) and team markets (Moneyline win/loss, Spread cover rate, Total over/under history). Cards show a "History since {date}" badge with the real earliest-data date for that league — not a marketing claim, an actual computed value. A "MLB Matchups" tab shows real batter-vs-pitcher career history for each game's probable starters, a "KBO Matchups" tab shows batter-vs-opponent-team career history (no per-pitcher splits exist anywhere for KBO — see Notes), a "Best No-Vig" tab ranks the best value edges across every supported league at once (auto-refreshing every 30s), and a "Golf" tab shows the live PGA Tour leaderboard with under-par highlighting, cross-referenced against 2021-2025 history for 7 recurring events.

**Supported leagues** (41, grouped by sport — see `odds.js`'s `LEAGUE_GROUPS`): Football (NFL, College Football, CFL, USFL, XFL), Basketball (NBA, College Basketball, WNBA, NBA G League), Baseball (MLB, NPB, KBO, CPBL, MLB Minors/AAA, WBC, LBPRC, LIDOM, LMP, LVBP), Hockey (NHL, AHL, KHL, SHL), Soccer (Premier League, Champions League, Europa League, La Liga, Bundesliga, Serie A, Ligue 1, MLS, Brasileiro Série A, Liga MX, International Soccer), Handball (EHF European League, EHF European Cup, SEHA Liga, IHF Super Globe), Tennis (ATP, WTA), MMA (UFC). Golf (PGA, LIV) and SportsGameOdds' NON_SPORTS categories (Politics, TV, Movies, Music, Fun, Events, Weather, Markets) are deliberately excluded — those are outright/prop formats with no home/away pairing, which this app's "Team A @ Team B" card model can't represent without a different UI.

Odds data comes from the [SportsGameOdds](https://sportsgameodds.com) API. Batter/pitcher matchup data comes from [MLB's own public Stats API](https://statsapi.mlb.com) (the same one MLB.com's stat pages use — unauthenticated, no key needed). KBO matchup data is scraped from [mykbostats.com](https://mykbostats.com), a fan-run site with no official API (see Notes/limitations — this is the one part of the app that isn't a licensed/official data source). Vantage does not accept wagers, hold funds, or process payments — it's a read-only comparison layer. Sportsbook links open the bookmaker's own site/app.

## Architecture

- `server.py` — stdlib-only Python server. Serves the static frontend and exposes:
  - `/api/markets?league=NFL` — fetches + normalizes upcoming odds into card view-models (best price, fair odds, edge %, no-vig probability, per-bookmaker rows). Cached 20s.
  - `/api/game-log?league=...&teamID=...&statID=...&opponentTeamID=...&playerID=` — paginates through every finalized game SportsGameOdds has for that team (the API caps each page at 50, so this walks the `cursor` until exhausted). With `playerID`, extracts that player's stat line per game; without it, `statID` must be one of `team_win`/`team_margin`/`game_total`, computed from the team's own scoring. Returns full history + head-to-head splits + a `coverage` block. Cached 24h since finalized results don't change.
  - `/api/mlb-matchups?homeTeamID=...&awayTeamID=...&gameDate=YYYY-MM-DD` — looks up that game's probable starting pitchers via MLB's schedule endpoint, pulls each opposing team's active-roster hitters, and fetches each hitter's career at-bat history against that specific pitcher (MLB's `vsPlayer` split), aggregating the raw counting stats across seasons into one lifetime AVG/OBP/SLG/OPS line (rate stats aren't valid to average directly — only the underlying counts are). Fetches run in parallel via a thread pool since a full lineup is 10-15 independent calls. Cached: schedule/probable-pitcher lookups 2h, rosters 24h, matchup history 24h.
  - `/api/kbo-matchups?homeTeam=...&awayTeam=...` (team display names, e.g. `Kia Tigers`, not numeric ids — see below) — scrapes [mykbostats.com](https://mykbostats.com) for each team's roster, then each batter's own season game log, filtered to games against the named opponent and summed into one AB/H/R/RBI/HR/AVG line (plus Last 5/10/20-games recent-form views computed from that same game log — see the frontend's "Show" selector). Unlike MLB, there's no batter-vs-*specific-pitcher* data available anywhere for KBO (checked by hand: koreabaseball.com blocks bots, Statiz.co.kr is JS-only, mykbostats itself only tracks vs-team splits) — so this is structurally a vs-opponent-**team** feature only, with no pitcher-specific version to add later. mykbostats.com 403s a bare request (basic bot-protection), so this goes through `cloudscraper` instead of plain `urllib` — the one non-stdlib dependency in this codebase (see Setup). mykbostats also has its own separate 429 rate limit, hit in testing after switching between several different games quickly — on-demand fetches are deliberately gentle (small worker pool, a short stagger before each request, backoff-and-retry on both 403 and 429). A background job (`refresh_kbo_prewarm_loop`) walks every team's roster and every player's game log once a day at 11pm KST (chosen to reliably fall after that day's games finish, which normally run 6-7pm to 9:30-10:30pm KST -- padded for extra innings/doubleheaders; this is a fixed clock time, not a live "are games done yet" check, to avoid adding more scraping just to time the scraping), even slower/gentler than the on-demand path since nothing's waiting on it (a 20s pause between teams, 1s between players) so a live click almost always hits an already-warm cache instead of triggering the real scrape on the spot; the roster and game-log cache TTLs (26h each) are set to comfortably outlive the ~24h gap between prewarm cycles. Team-name matching between SportsGameOdds' KBO output and mykbostats' own naming has **not been confirmed** — `_resolve_kbo_team` in `server.py` does exact/case-insensitive/substring fallback matching, and raises a clear error naming the exact unmatched string if a team ever fails to resolve; fix by adding an alias to `KBO_TEAM_ROSTER`. Cached: rosters 26h, each batter's game log 26h.
  - `/api/best-no-vig` — ranks edge % across all 41 leagues (excluding an upper sanity cap that filters out illiquid/rare-prop artifacts like "Triples Over 0.5" showing a nonsensical +600% "edge"), taking each league's own top slice before a final combined sort so MLB's far higher prop volume can't flood out the rest. Computed once every 25s by a background thread and served from that cache — never computed inline on a request thread, since fanning out to 41 leagues synchronously was OOM-crashing the process on a memory-constrained host.
  - `/api/golf` — auto-detects whichever PGA Tour event is currently live via [ESPN's public (unofficial) golf API](https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard), and for 7 recurring events (BMW Championship, Tour Championship, Bank of Utah Championship, Baycurrent Classic, Mexico Open, WWT Championship, RSM Classic) cross-references each live player against their own 2021-2025 under-par history at that same event. No key needed. ESPN's `?event=` query param on `/scoreboard` is silently ignored (always returns whatever's live) — historical lookups actually need the separate `/leaderboard?event=` endpoint. Akamai (fronting espn.com) blocks Python's own TLS/urllib stack outright regardless of headers, so these calls shell out to `curl` instead. Same background-refresh-into-cache pattern as Best No-Vig (every 90s).
  - `/deploy` — a POST-only webhook target for GitHub's push events. Verifies the payload's HMAC-SHA256 signature against `DEPLOY_WEBHOOK_SECRET` before doing anything; on a verified push to `main`, runs `git pull && systemctl restart vantage`.
  - Both external APIs are called with a real browser `User-Agent` — Cloudflare (in front of SportsGameOdds) and other bot-protection blocks the default Python/curl UA string outright.
- `odds.js` / `mlb.js` / `kbo.js` — thin fetch clients; no parsing logic duplicated here.
- `sample-odds.js` — static fallback data (clearly fake) shown only if the live feed errors out.
- `app.js` / `index.html` / `style.css` — UI: a Markets/Best No-Vig/MLB Matchups/KBO Matchups/Golf tab toggle, league + market-type + sportsbook + stat-type filters, sort, card grid, detail modal (bookmaker table + no-vig + recent-form section), watchlist, theme toggle.

## Setup

Create `.env` in this folder (gitignored) with your own key:

```
SPORTSGAMEODDS_API_KEY=your_key_here
```

Install the one non-stdlib dependency (needed only for the KBO Matchups tab's mykbostats.com scraping — everything else in this app is stdlib-only):

```bash
pip3 install -r requirements.txt
```

## Run locally

```bash
python3 server.py
```

Then open http://localhost:5173

## Deploy to your own server (Oracle Cloud Always Free, or any VM)

This is what lets the [VantageIOS](../VantageIOS) app work on a real device, since a physical phone can't reach your Mac's `localhost`. This app previously ran on Render's free tier, but that tier's 512MB RAM was getting OOM-killed once the league count grew to 41 (each restart shows as an instant 502) — moved to a self-managed VM instead, which has far more headroom and doesn't spin down when idle.

1. Provision a VM (an Oracle Cloud "Always Free" Ampere instance works well — 4 OCPUs / 24GB RAM available on the free tier, though this app only needs a small fraction of that). Ubuntu is assumed below.
2. **Open port 80 in *two* places** — this is the most common gotcha:
   - The cloud provider's network-level firewall (on OCI: the instance's subnet → Security List → Add Ingress Rule, source `0.0.0.0/0`, TCP, port 80).
   - The instance's own OS-level firewall. Oracle's stock Ubuntu image ships `iptables` rules that allow only SSH by default and reject everything else — you need an explicit `ACCEPT` rule for port 80 too, added *before* the existing `REJECT` rule, then persisted (`sudo netfilter-persistent save`) so it survives reboots.
3. Install `git`, clone this repo, add `.env` with your `SPORTSGAMEODDS_API_KEY` (see Setup above) plus a `DEPLOY_WEBHOOK_SECRET` (any long random string) if you want auto-deploy — see below, and run `pip3 install -r requirements.txt` (needed for the KBO Matchups tab).
4. Run it as a systemd service so it survives reboots and restarts on crash:
   ```
   [Unit]
   Description=Vantage odds comparison server
   After=network.target

   [Service]
   Type=simple
   User=ubuntu
   WorkingDirectory=/home/ubuntu/vantage-odds
   Environment=PORT=80
   ExecStart=/usr/bin/python3 /home/ubuntu/vantage-odds/server.py
   Restart=always
   RestartSec=3
   AmbientCapabilities=CAP_NET_BIND_SERVICE

   [Install]
   WantedBy=multi-user.target
   ```
   `AmbientCapabilities=CAP_NET_BIND_SERVICE` lets the process bind port 80 without running as root. Then `sudo systemctl daemon-reload && sudo systemctl enable --now vantage`.
5. **Auto-deploy on push** (mirrors what Render's GitHub integration did): add a GitHub webhook (repo → Settings → Webhooks → Add webhook) pointing at `http://<your-ip>/deploy`, content type `application/json`, secret = your `DEPLOY_WEBHOOK_SECRET`, event = "Just the push event". The `/deploy` endpoint verifies GitHub's HMAC signature before doing anything, then runs `git pull && systemctl restart vantage` — which needs a narrow passwordless-sudo grant:
   ```
   echo 'ubuntu ALL=(ALL) NOPASSWD: /bin/systemctl restart vantage' | sudo tee /etc/sudoers.d/vantage-deploy
   sudo chmod 440 /etc/sudoers.d/vantage-deploy
   ```

Since this makes the API-comparison proxy reachable by anyone with the URL (not just you), keep in mind it draws against your own SportsGameOdds quota if someone else finds and hits it. There's no auth on the app's own API routes — only `/deploy` is authenticated (via the webhook signature).

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
- **KBO Matchups is the one part of this app not built on an official/licensed API.** mykbostats.com is a fan-run site with no public API, no documented stability guarantees, and active (if basic) bot-protection — this feature is inherently more fragile than everything else here and more likely to need maintenance if that site's markup or protection changes. It also has no batter-vs-specific-pitcher data at all (a real gap checked by hand across every KBO stats source available, not a corner cut for time) and no live in-progress-game reconstruction (a batter's numbers reflect whatever mykbostats has published on their own page, with whatever staleness that implies — same category of tradeoff as any other non-hand-verified stats source, just worth calling out since it's the newest, least-tested endpoint in this codebase). Team-name matching against SportsGameOdds' KBO output is unconfirmed — see the `/api/kbo-matchups` note above.
