#!/usr/bin/env python3
"""Local dev server for Vantage: serves the static frontend, and exposes
/api/markets and /api/game-log, both backed by SportsGameOdds. The API key
lives only here, never reaching the browser or any client app.
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", 5173))
UPSTREAM_BASE = "https://api.sportsgameodds.com/v2"
MARKETS_CACHE_TTL = 20
GAME_LOG_CACHE_TTL = 24 * 60 * 60  # finalized games don't change
GAME_LOG_MAX_PAGES = 12  # 12 * 50 = 600 events, well beyond ~2.5 seasons for any league

_cache = {}  # cache namespace + query string -> (expires_at, parsed_json)


def load_env_file(path=None):
    path = path or os.path.join(SCRIPT_DIR, ".env")
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


load_env_file()
API_KEY = os.environ.get("SPORTSGAMEODDS_API_KEY", "")

MARKET_TYPE_BY_BETTYPE = {"ml": "Moneyline", "sp": "Spread", "ou": "Total"}

BOOKMAKER_LABELS = {
    "fanduel": "FanDuel", "draftkings": "DraftKings", "betmgm": "BetMGM",
    "caesars": "Caesars", "espnbet": "ESPN BET", "bovada": "Bovada",
    "betrivers": "BetRivers", "unibet": "Unibet", "pinnacle": "Pinnacle",
    "betonline": "BetOnline", "lowvig": "LowVig", "hardrockbet": "Hard Rock Bet",
    "betparx": "betPARX", "ballybet": "Bally Bet", "fliff": "Fliff",
}


class UpstreamError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def _get_json(url):
    req = urllib.request.Request(
        url,
        headers={
            "x-api-key": API_KEY,
            "User-Agent": "Mozilla/5.0 (compatible; VantageDemo/1.0)",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read()
    except urllib.error.HTTPError as e:
        raise UpstreamError(e.code, e.read().decode("utf-8", "replace"))
    except urllib.error.URLError as e:
        raise UpstreamError(502, f"Could not reach SportsGameOdds: {e.reason}")

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        raise UpstreamError(502, "SportsGameOdds returned a non-JSON response")

    if parsed.get("success") is False:
        raise UpstreamError(502, parsed.get("error") or "SportsGameOdds request failed")
    return parsed


def fetch_events(params, cache_ns, ttl):
    query = urllib.parse.urlencode(params)
    cache_key = f"{cache_ns}:{query}"
    cached = _cache.get(cache_key)
    if cached and cached[0] > time.time():
        return cached[1]

    parsed = _get_json(f"{UPSTREAM_BASE}/events?{query}")
    _cache[cache_key] = (time.time() + ttl, parsed)
    return parsed


def fetch_all_events(params, cache_ns, ttl, max_pages=GAME_LOG_MAX_PAGES):
    """Paginate through every available page (via `cursor`) and return the
    combined event list. SportsGameOdds caps each page at 50 regardless of
    the requested `limit`, so multi-season history needs real pagination."""
    query = urllib.parse.urlencode(params)
    cache_key = f"{cache_ns}:all:{query}"
    cached = _cache.get(cache_key)
    if cached and cached[0] > time.time():
        return cached[1]

    all_events = []
    cursor = None
    for _ in range(max_pages):
        page_params = dict(params)
        if cursor:
            page_params["cursor"] = cursor
        page = _get_json(f"{UPSTREAM_BASE}/events?{urllib.parse.urlencode(page_params)}")
        all_events.extend(page.get("data") or [])
        cursor = page.get("nextCursor")
        if not cursor:
            break

    _cache[cache_key] = (time.time() + ttl, all_events)
    return all_events


def bookmaker_label(key):
    return BOOKMAKER_LABELS.get(key, key.replace("_", " ").title())


def american_to_decimal(american):
    try:
        n = int(american)
    except (TypeError, ValueError):
        return None
    return 1 + n / 100 if n > 0 else 1 + 100 / abs(n)


def american_to_implied_prob(american):
    try:
        n = int(american)
    except (TypeError, ValueError):
        return None
    return 100 / (n + 100) if n > 0 else abs(n) / (abs(n) + 100)


def compute_no_vig_prob(odd, event_odds, best_price, best_book):
    """No-vig (de-vigged) probability for the side being shown, derived from
    the SAME bookmaker's two-sided market where possible (falls back to the
    blended consensus line if that book doesn't quote the opposing side) --
    this is the classic "remove the juice" calculation, distinct from the
    API's own blended `fairOdds`, which mixes many books together."""
    opposing_id = odd.get("opposingOddID")
    opposing = event_odds.get(opposing_id) if opposing_id else None
    if not opposing:
        return None

    opposing_price = None
    if best_book:
        book_entry = (opposing.get("byBookmaker") or {}).get(best_book)
        if book_entry and book_entry.get("available") and book_entry.get("odds"):
            opposing_price = book_entry["odds"]
    if opposing_price is None and opposing.get("bookOddsAvailable") and opposing.get("bookOdds"):
        opposing_price = opposing["bookOdds"]
    if opposing_price is None:
        return None

    p_side = american_to_implied_prob(best_price)
    p_opp = american_to_implied_prob(opposing_price)
    if p_side is None or p_opp is None or (p_side + p_opp) == 0:
        return None
    return round((p_side / (p_side + p_opp)) * 1000) / 10


def team_short_name(team_obj):
    if not team_obj:
        return "Unknown"
    names = team_obj.get("names") or {}
    return names.get("medium") or names.get("short") or names.get("long") or "Unknown"


def build_markets(events):
    items = []
    for event in events:
        teams = event.get("teams") or {}
        home = team_short_name(teams.get("home"))
        away = team_short_name(teams.get("away"))
        matchup = f"{away} @ {home}"
        starts_at = (event.get("status") or {}).get("startsAt")
        players = event.get("players") or {}
        home_team_id = (teams.get("home") or {}).get("teamID")
        away_team_id = (teams.get("away") or {}).get("teamID")

        event_odds = event.get("odds") or {}
        for odd_id, odd in event_odds.items():
            if odd.get("periodID") != "game":
                continue
            bet_type = odd.get("betTypeID")
            market_type = MARKET_TYPE_BY_BETTYPE.get(bet_type)
            if not market_type:
                continue

            stat_entity = odd.get("statEntityID")
            is_player_prop = stat_entity in players
            if market_type == "Total" and stat_entity != "all" and not is_player_prop:
                continue  # skip team sub-totals for this MVP

            book_entries = []
            for book, v in (odd.get("byBookmaker") or {}).items():
                if not v.get("available") or not v.get("odds"):
                    continue
                dec = american_to_decimal(v["odds"])
                if dec is None:
                    continue
                book_entries.append({
                    "book": book,
                    "label": bookmaker_label(book),
                    "american": v["odds"],
                    "deeplink": v.get("deeplink"),
                    "_decimal": dec,
                })
            book_entries.sort(key=lambda b: b["_decimal"], reverse=True)

            fair_decimal = american_to_decimal(odd.get("fairOdds")) if odd.get("fairOddsAvailable") else None

            if book_entries:
                best = book_entries[0]
                best_price = best["american"]
                best_vendor = best["label"]
                best_deeplink = best["deeplink"]
                best_book_key = best["book"]
            elif odd.get("bookOddsAvailable") and odd.get("bookOdds"):
                # No per-book breakdown at this API tier (common for player props) --
                # fall back to the single consensus line so the market is still shown.
                best_price = odd["bookOdds"]
                best_vendor = "Consensus"
                best_deeplink = None
                best_book_key = None
            else:
                continue

            best_decimal = american_to_decimal(best_price)
            edge_pct = round(((best_decimal - fair_decimal) / fair_decimal) * 1000) / 10 if (fair_decimal and best_decimal) else None
            no_vig_prob = compute_no_vig_prob(odd, event_odds, best_price, best_book_key)

            if bet_type == "ou":
                side_label = "Over" if odd.get("sideID") == "over" else "Under"
            else:
                side_label = home if stat_entity == "home" else away

            line = f" {odd['bookOverUnder']}" if odd.get("bookOverUnder") else ""
            if is_player_prop:
                player = players.get(stat_entity, {})
                name = f"{odd.get('marketName', market_type)} {side_label}{line}"
                player_team_id = player.get("teamID")
                opponent_team_id = away_team_id if player_team_id == home_team_id else home_team_id
            else:
                name = f"{matchup} — Total {side_label}{line}" if market_type == "Total" else f"{matchup} — {market_type} ({side_label})"
                player_team_id = None
                opponent_team_id = None

            items.append({
                "id": f"{event['eventID']}-{odd_id}",
                "league": event.get("leagueID"),
                "marketType": "Player Prop" if is_player_prop else market_type,
                "matchup": matchup,
                "startsAt": starts_at,
                "name": name,
                "bookmakers": [{k: v for k, v in b.items() if k != "_decimal"} for b in book_entries],
                "bestPrice": best_price,
                "bestVendor": best_vendor,
                "bestDeeplink": best_deeplink,
                "fairOdds": odd.get("fairOdds") if odd.get("fairOddsAvailable") else None,
                "openBookOdds": odd.get("openBookOdds"),
                "edgePct": edge_pct,
                "noVigProb": no_vig_prob,
                "isOutlier": edge_pct is not None and edge_pct >= 2,
                "statID": odd.get("statID") if is_player_prop else None,
                "playerID": stat_entity if is_player_prop else None,
                "playerTeamID": player_team_id,
                "opponentTeamID": opponent_team_id,
                "line": odd.get("bookOverUnder"),
                "side": odd.get("sideID"),
            })
    return items


def build_game_log(events, player_id, stat_id, team_id, opponent_team_id):
    games = []
    earliest_scanned = None
    for event in events:
        starts_at = (event.get("status") or {}).get("startsAt")
        if starts_at and (earliest_scanned is None or starts_at < earliest_scanned):
            earliest_scanned = starts_at
        if event.get("type") != "match":
            continue
        results = event.get("results") or {}
        game_results = results.get("game") or {}
        player_line = game_results.get(player_id)
        if not player_line or stat_id not in player_line:
            continue
        teams = event.get("teams") or {}
        home_id = (teams.get("home") or {}).get("teamID")
        is_home = home_id == team_id
        opp_team = teams.get("away") if is_home else teams.get("home")
        games.append({
            "eventID": event["eventID"],
            "date": starts_at,
            "home": is_home,
            "opponentTeamID": (opp_team or {}).get("teamID"),
            "opponentName": team_short_name(opp_team),
            "statValue": player_line[stat_id],
        })
    games.sort(key=lambda g: g["date"] or "", reverse=True)
    h2h = [g for g in games if opponent_team_id and g["opponentTeamID"] == opponent_team_id]
    return {
        "games": games,
        "h2h": h2h,
        "coverage": {"earliestAvailable": earliest_scanned, "eventsScanned": len(events), "gamesPlayed": len(games)},
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[vantage] {self.address_string()} - {fmt % args}")

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/api/markets":
            self.handle_markets(parsed)
        elif parsed.path == "/api/game-log":
            self.handle_game_log(parsed)
        else:
            self.handle_static(parsed)

    def require_api_key(self):
        if not API_KEY:
            self.send_json(500, {"error": "SPORTSGAMEODDS_API_KEY is not set on the server"})
            return False
        return True

    def handle_markets(self, parsed):
        if not self.require_api_key():
            return
        qs = urllib.parse.parse_qs(parsed.query)
        league_id = (qs.get("league") or ["NFL"])[0]
        try:
            data = fetch_events(
                {"leagueID": league_id, "oddsAvailable": "true", "limit": "12"},
                cache_ns="markets",
                ttl=MARKETS_CACHE_TTL,
            )
            items = build_markets(data.get("data") or [])
            self.send_json(200, {"success": True, "items": items})
        except UpstreamError as e:
            self.send_json(e.status if e.status < 600 else 502, {"success": False, "error": e.message})

    def handle_game_log(self, parsed):
        if not self.require_api_key():
            return
        qs = urllib.parse.parse_qs(parsed.query)

        def one(key, default=None):
            return (qs.get(key) or [default])[0]

        league_id = one("league")
        team_id = one("teamID")
        player_id = one("playerID")
        stat_id = one("statID")
        opponent_team_id = one("opponentTeamID")

        if not all([league_id, team_id, player_id, stat_id]):
            self.send_json(400, {"success": False, "error": "league, teamID, playerID, and statID are required"})
            return

        try:
            events = fetch_all_events(
                {"leagueID": league_id, "teamID": team_id, "finalized": "true", "limit": "50"},
                cache_ns="gamelog",
                ttl=GAME_LOG_CACHE_TTL,
            )
            result = build_game_log(events, player_id, stat_id, team_id, opponent_team_id)
            self.send_json(200, {"success": True, **result})
        except UpstreamError as e:
            self.send_json(e.status if e.status < 600 else 502, {"success": False, "error": e.message})

    def handle_static(self, parsed):
        path = parsed.path
        if path == "/":
            path = "/index.html"
        safe_path = os.path.normpath(path).lstrip("/")
        full_path = os.path.join(SCRIPT_DIR, safe_path)
        if not full_path.startswith(SCRIPT_DIR) or not os.path.isfile(full_path):
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not found")
            return

        content_types = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
        }
        ext = os.path.splitext(full_path)[1]
        content_type = content_types.get(ext, "application/octet-stream")

        with open(full_path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    if not API_KEY:
        print("[vantage] WARNING: SPORTSGAMEODDS_API_KEY not found in environment or .env file.")
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[vantage] Serving on http://localhost:{PORT}")
    server.serve_forever()
