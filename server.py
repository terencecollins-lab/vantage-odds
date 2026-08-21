#!/usr/bin/env python3
"""Local dev server for Vantage: serves the static frontend, and exposes
/api/markets and /api/game-log, both backed by SportsGameOdds. The API key
lives only here, never reaching the browser or any client app.
"""

import concurrent.futures
import datetime
import json
import os
import re
import subprocess
import threading
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
COVERAGE_CACHE_TTL = 7 * 24 * 60 * 60  # this floor essentially never moves

MLB_STATS_BASE = "https://statsapi.mlb.com/api/v1"
MLB_SCHEDULE_CACHE_TTL = 2 * 60 * 60  # probable pitchers can be announced/updated
MLB_ROSTER_CACHE_TTL = 24 * 60 * 60
MLB_VSPLAYER_CACHE_TTL = 24 * 60 * 60  # career history barely moves day to day

# SportsGameOdds teamID -> MLB Stats API's own numeric team id (statsapi.mlb.com
# has no relation to SportsGameOdds' naming, so this has to be hand-mapped).
MLB_TEAM_STATSAPI_ID = {
    "ARIZONA_DIAMONDBACKS_MLB": 109,
    "ATLANTA_BRAVES_MLB": 144,
    "BALTIMORE_ORIOLES_MLB": 110,
    "BOSTON_RED_SOX_MLB": 111,
    "CHICAGO_CUBS_MLB": 112,
    "CHICAGO_WHITE_SOX_MLB": 145,
    "CINCINNATI_REDS_MLB": 113,
    "CLEVELAND_GUARDIANS_MLB": 114,
    "COLORADO_ROCKIES_MLB": 115,
    "DETROIT_TIGERS_MLB": 116,
    "HOUSTON_ASTROS_MLB": 117,
    "KANSAS_CITY_ROYALS_MLB": 118,
    "LOS_ANGELES_ANGELS_MLB": 108,
    "LOS_ANGELES_DODGERS_MLB": 119,
    "MIAMI_MARLINS_MLB": 146,
    "MILWAUKEE_BREWERS_MLB": 158,
    "MINNESOTA_TWINS_MLB": 142,
    "NEW_YORK_METS_MLB": 121,
    "NEW_YORK_YANKEES_MLB": 147,
    "OAKLAND_ATHLETICS_MLB": 133,
    "PHILADELPHIA_PHILLIES_MLB": 143,
    "PITTSBURGH_PIRATES_MLB": 134,
    "SAN_DIEGO_PADRES_MLB": 135,
    "SAN_FRANCISCO_GIANTS_MLB": 137,
    "SEATTLE_MARINERS_MLB": 136,
    "STLOUIS_CARDINALS_MLB": 138,
    "TAMPA_BAY_RAYS_MLB": 139,
    "TEXAS_RANGERS_MLB": 140,
    "TORONTO_BLUE_JAYS_MLB": 141,
    "WASHINGTON_NATIONALS_MLB": 120,
}

_cache = {}  # cache namespace + query string -> (expires_at, parsed_json)
_cache_writes_since_sweep = 0
_CACHE_SWEEP_EVERY = 25


def _cache_set(key, ttl, value):
    # Every distinct (namespace, query) pair gets its own permanent dict slot
    # once written -- with 41 leagues' worth of teams/players/date-windows
    # now possible, the space of distinct cache keys is large enough that
    # entries were never being evicted, only overwritten if the exact same
    # key came up again. Over a long-running process that grows without
    # bound. A cheap periodic sweep of anything already past its own TTL
    # keeps steady-state memory bounded to "what's still live" instead of
    # "everything ever computed".
    global _cache_writes_since_sweep
    _cache[key] = (time.time() + ttl, value)
    _cache_writes_since_sweep += 1
    if _cache_writes_since_sweep >= _CACHE_SWEEP_EVERY:
        _cache_writes_since_sweep = 0
        now = time.time()
        for k in [k for k, (expires_at, _) in _cache.items() if expires_at <= now]:
            del _cache[k]


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

# Every league SportsGameOdds exposes that still fits Vantage's "Team A @ Team
# B" card model (head-to-head team or 1v1 matchups). Golf (PGA_MEN, LIV_TOUR)
# and the NON_SPORTS categories (Politics, TV, Movies, Music, Fun, Events,
# Weather, Celebrities, Markets) are deliberately excluded -- those are
# outright/prop formats with no home/away pairing, which this card model
# can't represent.
ALL_LEAGUES = [
    "NFL", "NCAAF", "CFL", "USFL", "XFL",
    "NBA", "NCAAB", "WNBA", "NBA_G_LEAGUE",
    "MLB", "NPB", "KBO", "CPBL", "MILB_AAA", "WBC", "LBPRC", "LIDOM", "LMP", "LVBP",
    "NHL", "AHL", "KHL", "SHL",
    "EPL", "UEFA_CHAMPIONS_LEAGUE", "UEFA_EUROPA_LEAGUE", "LA_LIGA", "BUNDESLIGA",
    "IT_SERIE_A", "FR_LIGUE_1", "MLS", "BR_SERIE_A", "LIGA_MX", "INTERNATIONAL_SOCCER",
    "EHF_EURO", "EHF_EURO_CUP", "SEHA", "IHF_SUPER_GLOBE",
    "ATP", "WTA",
    "UFC",
]
BEST_NO_VIG_TOP_N = 40
BEST_NO_VIG_MAX_EDGE_PCT = 12  # excludes illiquid/rare-prop artifacts (see below)
# Render's free tier is 512MB RAM / a shared 0.1 vCPU. This endpoint doesn't
# need every prop from every league, just enough events to find a handful of
# good edges per league -- see compute_best_no_vig for why it fetches
# leagues one at a time rather than fanning out.
BEST_NO_VIG_EVENT_LIMIT = 6

BOOKMAKER_LABELS = {
    "fanduel": "FanDuel", "draftkings": "DraftKings", "betmgm": "BetMGM",
    "caesars": "Caesars", "espnbet": "ESPN BET", "bovada": "Bovada",
    "betrivers": "BetRivers", "unibet": "Unibet", "pinnacle": "Pinnacle",
    "betonline": "BetOnline", "lowvig": "LowVig", "hardrockbet": "Hard Rock Bet",
    "betparx": "betPARX", "ballybet": "Bally Bet", "fliff": "Fliff",
    "bet365": "bet365", "fanatics": "Fanatics", "mybookie": "MyBookie",
    "betanysports": "BetAnySports", "betfairexchange": "Betfair Exchange",
    "betfairsportsbook": "Betfair Sportsbook", "sugarhouse": "SugarHouse",
    "gtbets": "GTbets", "prophetexchange": "Prophet Exchange", "betus": "BetUS",
    "bookmakereu": "Bookmaker.eu", "prizepicks": "PrizePicks", "novig": "Novig",
    "1xbet": "1xBet", "betrsportsbook": "Betr Sportsbook", "betsson": "Betsson",
    "everygame": "Everygame", "grosvenor": "Grosvenor", "ladbrokes": "Ladbrokes",
    "leovegas": "LeoVegas", "matchbook": "Matchbook", "neds": "Neds",
    "nordicbet": "NordicBet", "paddypower": "Paddy Power", "playup": "PlayUp",
    "polymarket": "Polymarket", "sportsbet": "Sportsbet", "tab": "TAB",
    "tabtouch": "TABtouch", "thescorebet": "theScore Bet",
}

# This key sometimes shows up in byBookmaker for an unidentified source --
# odds with no attributable book aren't useful for a "shop this book" comparison.
IGNORED_BOOKMAKER_KEYS = {"unknown"}


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
    _cache_set(cache_key, ttl, parsed)
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

    _cache_set(cache_key, ttl, all_events)
    return all_events


def fetch_all_events_windowed(params, cache_ns, ttl, earliest_iso, window_days=30, max_workers=20):
    """Team-scoped variant of fetch_all_events that fans out across date
    windows in parallel instead of walking the cursor sequentially one page
    at a time. Cursor pagination can't be parallelized (each page's cursor
    depends on the previous response), but independent date ranges can --
    for a high-volume league (MLB especially) walking 10+ pages one at a
    time was slow enough to occasionally get cut off before finishing."""
    query = urllib.parse.urlencode(params)
    cache_key = f"{cache_ns}:windowed:{query}"
    cached = _cache.get(cache_key)
    if cached and cached[0] > time.time():
        return cached[1]

    try:
        start = datetime.datetime.fromisoformat(earliest_iso.replace("Z", "+00:00"))
    except (ValueError, AttributeError, TypeError):
        start = datetime.datetime(2024, 1, 1, tzinfo=datetime.timezone.utc)
    end = datetime.datetime.now(datetime.timezone.utc)

    windows = []
    cursor_dt = start
    while cursor_dt < end:
        window_end = min(cursor_dt + datetime.timedelta(days=window_days), end)
        windows.append((cursor_dt, window_end))
        cursor_dt = window_end

    def fetch_window(bounds):
        w_start, w_end = bounds
        window_params = dict(params)
        window_params["startsAfter"] = w_start.strftime("%Y-%m-%dT%H:%M:%S.000Z")
        window_params["startsBefore"] = w_end.strftime("%Y-%m-%dT%H:%M:%S.000Z")
        events = []
        cursor = None
        for _ in range(3):  # a single team in one ~month window shouldn't need more
            page_params = dict(window_params)
            if cursor:
                page_params["cursor"] = cursor
            page = _get_json(f"{UPSTREAM_BASE}/events?{urllib.parse.urlencode(page_params)}")
            events.extend(page.get("data") or [])
            cursor = page.get("nextCursor")
            if not cursor:
                break
        return events

    all_events = []
    if windows:
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
            for events in pool.map(fetch_window, windows):
                all_events.extend(events)

    _cache_set(cache_key, ttl, all_events)
    return all_events


def get_league_coverage_since(league_id):
    """True earliest finalized-game date SportsGameOdds has for this league --
    events come back ascending by date when no teamID is given, so a handful
    of pages is enough to find the real floor rather than one team's own."""
    cache_key = f"coverage:{league_id}"
    cached = _cache.get(cache_key)
    if cached and cached[0] > time.time():
        return cached[1]
    events = fetch_all_events(
        {"leagueID": league_id, "finalized": "true", "limit": "50"},
        cache_ns="coverage_scan",
        ttl=COVERAGE_CACHE_TTL,
        max_pages=4,
    )
    dates = [(e.get("status") or {}).get("startsAt") for e in events]
    dates = [d for d in dates if d]
    earliest = min(dates) if dates else None
    _cache_set(cache_key, COVERAGE_CACHE_TTL, earliest)
    return earliest


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


TEAM_STAT_LABELS = {
    "team_win": "Moneyline (W/L)",
    "team_margin": "Against the Spread",
    "game_total": "Game Total",
}


def humanize_stat_id(stat_id):
    """'passing_yards' -> 'Passing Yards', 'fieldGoals_made' -> 'Field Goals Made'."""
    if stat_id in TEAM_STAT_LABELS:
        return TEAM_STAT_LABELS[stat_id]
    if not stat_id:
        return None
    words = []
    for part in stat_id.split("_"):
        subwords = re.findall(r"[A-Z]?[a-z0-9]+|[A-Z]+(?=[A-Z]|$)", part)
        words.extend(subwords or [part])
    return " ".join(w.capitalize() for w in words)


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
            bet_type = odd.get("betTypeID")
            period = odd.get("periodID")
            # Soccer/handball have no draw-less full-game moneyline at periodID
            # "game" -- their 2-way (draw-no-bet) line only exists at "reg"
            # (regulation). Everything else (Spread/Total, every other league)
            # still requires "game" so this doesn't pull in duplicate
            # regulation-only Totals/Spreads alongside the full-game ones.
            if period != "game" and not (period == "reg" and bet_type == "ml"):
                continue
            market_type = MARKET_TYPE_BY_BETTYPE.get(bet_type)
            if not market_type:
                continue

            stat_entity = odd.get("statEntityID")
            is_player_prop = stat_entity in players
            if market_type == "Total" and stat_entity != "all" and not is_player_prop:
                continue  # skip team sub-totals for this MVP

            # Consensus line first -- individual books can (and PrizePicks
            # especially does) quote a materially different number for what's
            # nominally "the same" prop, so this is the yardstick each book's
            # own line gets compared against.
            raw_line = odd.get("bookOverUnder") or odd.get("bookSpread")

            book_entries = []
            for book, v in (odd.get("byBookmaker") or {}).items():
                if book in IGNORED_BOOKMAKER_KEYS or not v.get("available") or not v.get("odds"):
                    continue
                dec = american_to_decimal(v["odds"])
                if dec is None:
                    continue
                book_line = v.get("overUnder") or v.get("spread")
                on_line = raw_line is None or book_line is None or book_line == raw_line
                book_entries.append({
                    "book": book,
                    "label": bookmaker_label(book),
                    "american": v["odds"],
                    "line": book_line,
                    "onLine": on_line,
                    "deeplink": v.get("deeplink"),
                    "_decimal": dec,
                })
            # Same-line books sort to the top by best payout; off-line books
            # (different line entirely -- not a comparable price) trail after.
            book_entries.sort(key=lambda b: (not b["onLine"], -b["_decimal"]))
            on_line_entries = [b for b in book_entries if b["onLine"]]

            fair_decimal = american_to_decimal(odd.get("fairOdds")) if odd.get("fairOddsAvailable") else None

            if on_line_entries:
                best = on_line_entries[0]
                best_price = best["american"]
                best_vendor = best["label"]
                best_deeplink = best["deeplink"]
                best_book_key = best["book"]
            elif odd.get("bookOddsAvailable") and odd.get("bookOdds"):
                # No book quotes this exact line -- fall back to the single
                # consensus line so the market is still shown.
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

            line_suffix = f" {raw_line}" if raw_line else ""

            if is_player_prop:
                player = players.get(stat_entity, {})
                name = f"{odd.get('marketName', market_type)} {side_label}{line_suffix}"
                stat_team_id = player.get("teamID")
                opponent_team_id = away_team_id if stat_team_id == home_team_id else home_team_id
                stat_id = odd.get("statID")
            elif market_type == "Total":
                # No single team owns a game total -- anchor its recent-form
                # history to the home team's own scoring across their games.
                name = f"{matchup} — Total {side_label}{line_suffix}"
                stat_team_id = home_team_id
                opponent_team_id = away_team_id
                stat_id = "game_total"
            else:
                name = f"{matchup} — {market_type} ({side_label}{line_suffix})"
                stat_team_id = home_team_id if stat_entity == "home" else away_team_id
                opponent_team_id = away_team_id if stat_entity == "home" else home_team_id
                stat_id = "team_win" if bet_type == "ml" else "team_margin"

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
                "statID": stat_id,
                "statLabel": humanize_stat_id(stat_id),
                "playerID": stat_entity if is_player_prop else None,
                "playerTeamID": stat_team_id,
                "opponentTeamID": opponent_team_id,
                "line": raw_line,
                "side": odd.get("sideID"),
            })
    return items


TEAM_STAT_IDS = {"team_win", "team_margin", "game_total"}


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
        teams = event.get("teams") or {}
        home_id = (teams.get("home") or {}).get("teamID")
        is_home = home_id == team_id

        if player_id:
            player_line = game_results.get(player_id)
            if not player_line or stat_id not in player_line:
                continue
            stat_value = player_line[stat_id]
        elif stat_id in TEAM_STAT_IDS:
            home_pts = (game_results.get("home") or {}).get("points")
            away_pts = (game_results.get("away") or {}).get("points")
            if home_pts is None or away_pts is None:
                continue
            own_pts, opp_pts = (home_pts, away_pts) if is_home else (away_pts, home_pts)
            if stat_id == "team_win":
                stat_value = 1 if own_pts > opp_pts else 0
            elif stat_id == "team_margin":
                stat_value = own_pts - opp_pts
            else:  # game_total
                stat_value = home_pts + away_pts
        else:
            continue

        opp_team = teams.get("away") if is_home else teams.get("home")
        games.append({
            "eventID": event["eventID"],
            "date": starts_at,
            "home": is_home,
            "opponentTeamID": (opp_team or {}).get("teamID"),
            "opponentName": team_short_name(opp_team),
            "statValue": stat_value,
        })
    games.sort(key=lambda g: g["date"] or "", reverse=True)
    h2h = [g for g in games if opponent_team_id and g["opponentTeamID"] == opponent_team_id]
    return {
        "games": games,
        "h2h": h2h,
        "coverage": {"earliestAvailable": earliest_scanned, "eventsScanned": len(events), "gamesPlayed": len(games)},
    }


def _fetch_mlb_json(url, cache_ns, ttl):
    """Generic fetcher for statsapi.mlb.com (MLB's own public Stats API --
    unauthenticated, no key required, same data MLB.com's own stat pages use)."""
    cache_key = f"{cache_ns}:{url}"
    cached = _cache.get(cache_key)
    if cached and cached[0] > time.time():
        return cached[1]

    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; VantageDemo/1.0)"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read()
    except urllib.error.HTTPError as e:
        raise UpstreamError(e.code, e.read().decode("utf-8", "replace"))
    except urllib.error.URLError as e:
        raise UpstreamError(502, f"Could not reach MLB Stats API: {e.reason}")

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        raise UpstreamError(502, "MLB Stats API returned a non-JSON response")

    _cache_set(cache_key, ttl, parsed)
    return parsed


def get_probable_pitchers(home_statsapi_id, away_statsapi_id, game_date):
    """Looks up the day's schedule and finds this specific matchup's
    probable starters -- returns {"home": {...} or None, "away": {...} or None}."""
    url = f"{MLB_STATS_BASE}/schedule?sportId=1&date={game_date}&hydrate=probablePitcher"
    data = _fetch_mlb_json(url, cache_ns="mlb_schedule", ttl=MLB_SCHEDULE_CACHE_TTL)
    for date_entry in data.get("dates", []):
        for game in date_entry.get("games", []):
            teams = game.get("teams", {})
            home_id = (teams.get("home", {}).get("team") or {}).get("id")
            away_id = (teams.get("away", {}).get("team") or {}).get("id")
            if home_id == home_statsapi_id and away_id == away_statsapi_id:
                result = {}
                for side in ("home", "away"):
                    pitcher = teams.get(side, {}).get("probablePitcher")
                    result[side] = {"id": pitcher["id"], "fullName": pitcher.get("fullName")} if pitcher else None
                return result
    return {"home": None, "away": None}


def get_active_hitters(team_statsapi_id):
    """Active roster for a team, excluding pitchers -- these are the
    plausible lineup candidates we'll pull batter-vs-pitcher splits for."""
    url = f"{MLB_STATS_BASE}/teams/{team_statsapi_id}/roster?rosterType=active"
    data = _fetch_mlb_json(url, cache_ns="mlb_roster", ttl=MLB_ROSTER_CACHE_TTL)
    hitters = []
    for entry in data.get("roster", []):
        position = (entry.get("position") or {}).get("abbreviation")
        if position == "P":
            continue
        person = entry.get("person") or {}
        hitters.append({"id": person.get("id"), "fullName": person.get("fullName"), "position": position})
    return hitters


def get_batter_vs_pitcher(batter_id, pitcher_id):
    """Aggregates a batter's career plate-appearance-level history against one
    specific pitcher (MLB's own vsPlayer split) into lifetime counting stats --
    OPS/AVG/SLG aren't valid to average across seasons, so we sum the raw
    counting stats and recompute the rate stats from those totals."""
    url = (
        f"{MLB_STATS_BASE}/people/{batter_id}/stats"
        f"?stats=vsPlayer&opposingPlayerId={pitcher_id}&group=hitting"
    )
    data = _fetch_mlb_json(url, cache_ns="mlb_vsplayer", ttl=MLB_VSPLAYER_CACHE_TTL)
    splits = (data.get("stats") or [{}])[0].get("splits") or []
    if not splits:
        return None

    totals = {"atBats": 0, "hits": 0, "homeRuns": 0, "baseOnBalls": 0, "strikeOuts": 0, "totalBases": 0, "hitByPitch": 0, "sacFlies": 0, "plateAppearances": 0}
    for split in splits:
        stat = split.get("stat") or {}
        for key in totals:
            totals[key] += stat.get(key) or 0

    ab, h, bb, hbp, sf, tb, pa = (totals[k] for k in ("atBats", "hits", "baseOnBalls", "hitByPitch", "sacFlies", "totalBases", "plateAppearances"))
    avg = round(h / ab, 3) if ab else None
    obp_denom = ab + bb + hbp + sf
    obp = round((h + bb + hbp) / obp_denom, 3) if obp_denom else None
    slg = round(tb / ab, 3) if ab else None
    ops = round(obp + slg, 3) if (obp is not None and slg is not None) else None

    return {
        "atBats": ab, "hits": h, "homeRuns": totals["homeRuns"], "walks": bb,
        "strikeouts": totals["strikeOuts"], "plateAppearances": pa,
        "avg": avg, "obp": obp, "slg": slg, "ops": ops,
    }


def build_mlb_matchup(home_team_id, away_team_id, game_date):
    home_statsapi_id = MLB_TEAM_STATSAPI_ID.get(home_team_id)
    away_statsapi_id = MLB_TEAM_STATSAPI_ID.get(away_team_id)
    if not home_statsapi_id or not away_statsapi_id:
        raise UpstreamError(400, "Unrecognized MLB team")

    pitchers = get_probable_pitchers(home_statsapi_id, away_statsapi_id, game_date)

    def side_matchups(pitcher, hitters):
        if not pitcher:
            return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda b: (b, get_batter_vs_pitcher(b["id"], pitcher["id"])), hitters))
        rows = [{**b, "stats": s} for b, s in results if s is not None]
        rows.sort(key=lambda r: r["stats"]["atBats"], reverse=True)
        return {"pitcher": pitcher, "batters": rows}

    return {
        # Home team's pitcher faces the away team's lineup, and vice versa.
        "homePitcherVsAwayHitters": side_matchups(pitchers["home"], get_active_hitters(away_statsapi_id)),
        "awayPitcherVsHomeHitters": side_matchups(pitchers["away"], get_active_hitters(home_statsapi_id)),
    }


ESPN_GOLF_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard"
ESPN_GOLF_LEADERBOARD = "https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard"
GOLF_LIVE_CACHE_TTL = 60
GOLF_SEASON_CACHE_TTL = 24 * 60 * 60
GOLF_FINAL_EVENT_CACHE_TTL = 30 * 24 * 60 * 60  # a finished tournament's result never changes

# The 7 recurring PGA Tour events this feature tracks under-par history for.
# Sponsor names change year to year (Black Desert Championship -> Bank of
# Utah Championship, Zozo Championship -> Baycurrent Classic), so each entry
# lists every name the event has gone by rather than assuming one fixed title.
GOLF_HISTORY_TOURNAMENTS = [
    {"key": "bmw_championship", "label": "BMW Championship", "aliases": ["bmw championship"]},
    {"key": "tour_championship", "label": "Tour Championship", "aliases": ["tour championship"]},
    {"key": "bank_of_utah", "label": "Bank of Utah Championship", "aliases": ["bank of utah championship", "black desert championship"]},
    {"key": "baycurrent_zozo", "label": "Baycurrent Classic (Zozo)", "aliases": ["baycurrent classic", "zozo championship"]},
    {"key": "mexico_open", "label": "Mexico Open", "aliases": ["mexico open"]},
    {"key": "wwt_championship", "label": "World Wide Technology Championship", "aliases": ["world wide technology championship"]},
    {"key": "rsm_classic", "label": "RSM Classic", "aliases": ["rsm classic"]},
]
GOLF_HISTORY_YEARS = [2021, 2022, 2023, 2024, 2025]


def _fetch_espn_json(url, cache_ns, ttl):
    """Generic fetcher for ESPN's public (unofficial, undocumented but
    unauthenticated) golf scoreboard/leaderboard endpoints.

    Akamai (fronting espn.com) fingerprints and blocks Python's own TLS/
    urllib stack outright -- even with a spoofed browser User-Agent header,
    every request came back an Akamai "Access Denied" page. Plain `curl`
    against the identical URL from the same machine went through with no
    special headers at all, so this shells out to curl (curl's TLS
    fingerprint isn't the one Akamai is blocking) rather than fighting
    urllib's fingerprint from inside Python."""
    cache_key = f"{cache_ns}:{url}"
    cached = _cache.get(cache_key)
    if cached and cached[0] > time.time():
        return cached[1]

    try:
        result = subprocess.run(
            ["curl", "-s", "--max-time", "15", url],
            capture_output=True, timeout=20,
        )
    except (subprocess.SubprocessError, OSError) as e:
        raise UpstreamError(502, f"Could not reach ESPN: {e}")
    if result.returncode != 0:
        raise UpstreamError(502, f"curl failed reaching ESPN (exit {result.returncode}): {result.stderr.decode('utf-8', 'replace')}")

    try:
        parsed = json.loads(result.stdout)
    except json.JSONDecodeError:
        raise UpstreamError(502, "ESPN returned a non-JSON response")

    _cache_set(cache_key, ttl, parsed)
    return parsed


def get_pga_season_schedule(year):
    """Every PGA Tour event in a season, with its ESPN event id -- lets us
    look a specific recurring tournament's id up by name/year instead of
    hand-maintaining a list (ESPN doesn't publish one)."""
    data = _fetch_espn_json(f"{ESPN_GOLF_SCOREBOARD}?dates={year}", cache_ns="golf_season", ttl=GOLF_SEASON_CACHE_TTL)
    return [{"id": e.get("id"), "name": e.get("name") or "", "date": e.get("date")} for e in data.get("events") or []]


def find_golf_event(year, aliases):
    for event in get_pga_season_schedule(year):
        name_lower = event["name"].lower()
        if any(alias in name_lower for alias in aliases):
            return event
    return None


def _parse_relative_to_par(display_value):
    if display_value is None:
        return None
    display_value = display_value.strip()
    if display_value in ("E", ""):
        return 0
    try:
        return int(display_value)
    except ValueError:
        return None


def parse_golf_event(raw):
    events = raw.get("events") or []
    if not events:
        return None
    event = events[0]
    competition = (event.get("competitions") or [{}])[0]
    status = ((competition.get("status") or {}).get("type") or {}).get("description")
    is_final = ((competition.get("status") or {}).get("type") or {}).get("completed") is True

    players = []
    for c in competition.get("competitors") or []:
        athlete = c.get("athlete") or {}
        rounds = []
        for ls in c.get("linescores") or []:
            strokes = ls.get("value")
            relative = _parse_relative_to_par(ls.get("displayValue"))
            if strokes is None or relative is None:
                continue
            par = strokes - relative
            rounds.append({"round": ls.get("period"), "strokes": strokes, "par": par, "underPar": strokes < par})
        under_par_rounds = [r["strokes"] for r in rounds if r["underPar"]]
        score = c.get("score")
        total_display = score.get("displayValue") if isinstance(score, dict) else score
        players.append({
            "athleteId": athlete.get("id"),
            "name": athlete.get("displayName"),
            "total": total_display,
            "rounds": rounds,
            "anyRoundUnderPar": len(under_par_rounds) > 0,
            "lowestRound": min(under_par_rounds) if under_par_rounds else (min((r["strokes"] for r in rounds), default=None)),
        })

    return {
        "eventId": event.get("id"),
        "name": event.get("name"),
        "date": event.get("date"),
        "status": status,
        "isFinal": is_final,
        "players": players,
    }


def get_golf_event(event_id):
    # Cache namespace deliberately excludes status -- a finished event is
    # fetched once and kept essentially forever; an in-progress one is
    # re-fetched every GOLF_LIVE_CACHE_TTL seconds regardless of which cache
    # key answered last time, since we don't know completion status until
    # after the fetch.
    cache_key = f"golf_event_parsed:{event_id}"
    cached = _cache.get(cache_key)
    if cached and cached[0] > time.time():
        return cached[1]
    raw = _fetch_espn_json(f"{ESPN_GOLF_LEADERBOARD}?event={event_id}", cache_ns="golf_event_raw", ttl=GOLF_LIVE_CACHE_TTL)
    parsed = parse_golf_event(raw)
    ttl = GOLF_FINAL_EVENT_CACHE_TTL if (parsed and parsed["isFinal"]) else GOLF_LIVE_CACHE_TTL
    _cache_set(cache_key, ttl, parsed)
    return parsed


def get_golf_history_index(tournament):
    """athleteId -> best historical under-par appearance for this tournament
    family, scanned across GOLF_HISTORY_YEARS. Each year's event lookup and
    leaderboard fetch is independently cached (long TTL, since finished
    results never change), so this is only ever slow on the very first call."""
    index = {}
    for year in GOLF_HISTORY_YEARS:
        event = find_golf_event(year, tournament["aliases"])
        if not event or not event["id"]:
            continue
        try:
            parsed = get_golf_event(event["id"])
        except UpstreamError:
            continue
        if not parsed:
            continue
        for p in parsed["players"]:
            if not p["athleteId"] or not p["anyRoundUnderPar"]:
                continue
            existing = index.get(p["athleteId"])
            if not existing or (p["lowestRound"] or 999) < (existing["lowestRound"] or 999):
                index[p["athleteId"]] = {"year": year, "lowestRound": p["lowestRound"]}
    return index


def compute_golf_view():
    live_raw = _fetch_espn_json(ESPN_GOLF_SCOREBOARD, cache_ns="golf_live", ttl=GOLF_LIVE_CACHE_TTL)
    live_events = live_raw.get("events") or []
    if not live_events:
        return {"success": True, "tournament": None, "leaderboard": [], "historyTournament": None}

    live_id = live_events[0].get("id")
    current = get_golf_event(live_id)
    if not current:
        return {"success": True, "tournament": None, "leaderboard": [], "historyTournament": None}

    name_lower = (current["name"] or "").lower()
    tournament_family = next(
        (t for t in GOLF_HISTORY_TOURNAMENTS if any(alias in name_lower for alias in t["aliases"])),
        None,
    )
    history_index = get_golf_history_index(tournament_family) if tournament_family else {}

    leaderboard = []
    for p in current["players"]:
        hist = history_index.get(p["athleteId"])
        leaderboard.append({
            **p,
            "historicalUnderPar": hist is not None,
            "historicalBestRound": hist["lowestRound"] if hist else None,
            "historicalYear": hist["year"] if hist else None,
        })

    return {
        "success": True,
        "tournament": {"name": current["name"], "date": current["date"], "status": current["status"]},
        "leaderboard": leaderboard,
        "historyTournament": tournament_family["label"] if tournament_family else None,
    }


def compute_best_no_vig():
    # Take each league's own top slice so one high-volume league (MLB has
    # 10x+ the props of the others) can't flood out the rest -- "across
    # sports" should actually mean across sports.
    per_league_slice = max(1, BEST_NO_VIG_TOP_N // len(ALL_LEAGUES))

    # Deliberately sequential, one league at a time, not fanned out over a
    # thread pool: this fan-out was OOM-crashing the process on Render's
    # 512MB free tier even at reduced concurrency, because retaining every
    # league's *full* item list (some -- MLB, NPB, KBO, CPBL, WBC, the
    # winter-ball leagues -- run thousands of player-prop odds per event) in
    # memory at once was the real cost, independent of how many ran
    # concurrently. Slicing each league down to its top few edges
    # immediately, before moving to the next league, means only one league's
    # full payload is ever in memory at a time, and the retained cross-league
    # total is at most BEST_NO_VIG_TOP_N items. This runs on a timer in the
    # background now, not on the request path, so the added wall-clock time
    # from going sequential costs nothing user-facing.
    coverage_map = {}
    errors = {}
    candidates = []
    for league_id in ALL_LEAGUES:
        try:
            data = fetch_events(
                {"leagueID": league_id, "oddsAvailable": "true", "limit": str(BEST_NO_VIG_EVENT_LIMIT)},
                cache_ns="best-no-vig",
                ttl=MARKETS_CACHE_TTL,
            )
            items = build_markets(data.get("data") or [])
            coverage_map[league_id] = get_league_coverage_since(league_id)
        except UpstreamError as e:
            errors[league_id] = e.message
            continue

        # Edge is only meaningful with a real fair-odds comparison, and only
        # a positive one is "value" at all. The upper cap excludes
        # ultra-rare props (e.g. "Triples Over 0.5") where a thin, illiquid
        # market can show a nonsensical multi-hundred-percent "edge" that's
        # a data/liquidity artifact, not a real opportunity -- genuine
        # sportsbook mispricing essentially never exceeds this range.
        ranked = [i for i in items if i.get("edgePct") is not None and 0 < i["edgePct"] <= BEST_NO_VIG_MAX_EDGE_PCT]
        ranked.sort(key=lambda i: i["edgePct"], reverse=True)
        candidates.extend(ranked[:per_league_slice])

    candidates.sort(key=lambda i: i["edgePct"], reverse=True)
    top = candidates[:BEST_NO_VIG_TOP_N]

    return {
        "success": True,
        "items": top,
        "coverageSince": coverage_map,
        "leagueErrors": errors or None,
    }


_best_no_vig_lock = threading.Lock()
_best_no_vig_cache = {"payload": None, "computed_at": 0}
BEST_NO_VIG_REFRESH_INTERVAL = 25  # slightly above MARKETS_CACHE_TTL


def refresh_best_no_vig_loop():
    # This aggregation is identical for every viewer, so it's computed once on
    # a timer and served from memory -- not recomputed per request. Besides
    # being wasteful, computing it inline per HTTP request meant concurrent
    # viewers (or the client's own 30s auto-refresh poll) could pile up
    # duplicate fan-outs to all 41 leagues at once, which was OOM-crashing the
    # process on Render's 512MB free tier (several of the newly added
    # leagues -- MLB, NPB, KBO, CPBL, WBC, the winter-ball leagues -- each
    # carry thousands of player-prop odds per event).
    while True:
        try:
            payload = compute_best_no_vig()
            with _best_no_vig_lock:
                _best_no_vig_cache["payload"] = payload
                _best_no_vig_cache["computed_at"] = time.time()
        except Exception as e:
            print(f"[vantage] best-no-vig background refresh failed: {e}")
        time.sleep(BEST_NO_VIG_REFRESH_INTERVAL)


_golf_lock = threading.Lock()
_golf_cache = {"payload": None}
GOLF_REFRESH_INTERVAL = 90  # live scores don't need to update faster than this


def refresh_golf_loop():
    while True:
        try:
            payload = compute_golf_view()
            with _golf_lock:
                _golf_cache["payload"] = payload
        except Exception as e:
            print(f"[vantage] golf background refresh failed: {e}")
        time.sleep(GOLF_REFRESH_INTERVAL)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[vantage] {self.address_string()} - {fmt % args}")

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/api/markets":
            self.handle_markets(parsed)
        elif parsed.path == "/api/game-log":
            self.handle_game_log(parsed)
        elif parsed.path == "/api/mlb-matchups":
            self.handle_mlb_matchups(parsed)
        elif parsed.path == "/api/best-no-vig":
            self.handle_best_no_vig(parsed)
        elif parsed.path == "/api/golf":
            self.handle_golf(parsed)
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
            coverage_since = get_league_coverage_since(league_id)
            self.send_json(200, {"success": True, "items": items, "coverageSince": coverage_since})
        except UpstreamError as e:
            self.send_json(e.status if e.status < 600 else 502, {"success": False, "error": e.message})

    def handle_best_no_vig(self, parsed):
        if not self.require_api_key():
            return
        with _best_no_vig_lock:
            payload = _best_no_vig_cache["payload"]
        if payload is None:
            # Background refresh loop hasn't completed its first cycle yet
            # (just after server startup). Computing all 41 leagues
            # sequentially takes well over a minute on Render's free-tier
            # CPU -- never do that inline on a request thread, since that's
            # long enough to hit Render's own proxy timeout. The frontend
            # already polls this endpoint every 30s, so it'll pick up the
            # real result on its own shortly.
            self.send_json(200, {"success": True, "items": [], "coverageSince": {}, "preparing": True})
            return
        self.send_json(200, payload)

    def handle_golf(self, parsed):
        with _golf_lock:
            payload = _golf_cache["payload"]
        if payload is None:
            self.send_json(200, {"success": True, "tournament": None, "leaderboard": [], "historyTournament": None, "preparing": True})
            return
        self.send_json(200, payload)

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

        if not all([league_id, team_id, stat_id]):
            self.send_json(400, {"success": False, "error": "league, teamID, and statID are required"})
            return
        if not player_id and stat_id not in TEAM_STAT_IDS:
            self.send_json(400, {"success": False, "error": f"statID '{stat_id}' requires playerID"})
            return

        try:
            earliest = get_league_coverage_since(league_id)
            events = fetch_all_events_windowed(
                {"leagueID": league_id, "teamID": team_id, "finalized": "true", "limit": "50"},
                cache_ns="gamelog",
                ttl=GAME_LOG_CACHE_TTL,
                earliest_iso=earliest,
            )
            result = build_game_log(events, player_id, stat_id, team_id, opponent_team_id)
            self.send_json(200, {"success": True, **result})
        except UpstreamError as e:
            self.send_json(e.status if e.status < 600 else 502, {"success": False, "error": e.message})

    def handle_mlb_matchups(self, parsed):
        qs = urllib.parse.parse_qs(parsed.query)

        def one(key, default=None):
            return (qs.get(key) or [default])[0]

        home_team_id = one("homeTeamID")
        away_team_id = one("awayTeamID")
        game_date = one("gameDate")  # YYYY-MM-DD

        if not all([home_team_id, away_team_id, game_date]):
            self.send_json(400, {"success": False, "error": "homeTeamID, awayTeamID, and gameDate are required"})
            return

        try:
            result = build_mlb_matchup(home_team_id, away_team_id, game_date)
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
    else:
        threading.Thread(target=refresh_best_no_vig_loop, daemon=True).start()
    threading.Thread(target=refresh_golf_loop, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[vantage] Serving on http://localhost:{PORT}")
    server.serve_forever()
