#!/usr/bin/env python3
"""Local dev server for Vantage: serves the static frontend, and exposes
/api/markets and /api/game-log, both backed by SportsGameOdds. The API key
lives only here, never reaching the browser or any client app.
"""

import collections
import concurrent.futures
import datetime
import hashlib
import hmac
import html
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

_cache = collections.OrderedDict()  # cache namespace + query string -> (expires_at, parsed_json)
_cache_writes_since_sweep = 0
_CACHE_SWEEP_EVERY = 25
_CACHE_MAX_ENTRIES = 600
# The TTL sweep in _cache_set only removes an entry once it's already past
# its own expiry -- with some TTLs as long as 24-30h (game logs, KBO
# rosters/player pages), a single long session that touches many distinct
# league/team/player/date-window combinations can accumulate a large
# number of live, not-yet-expired entries well before any of them age out.
# Some of those payloads are large too -- a single windowed MLB game-log
# fetch can carry thousands of raw event dicts. This hard cap bounds
# worst-case memory regardless of TTL: a real OOM kill was observed in
# production (systemd log: 'Main process exited, code=killed,
# status=9/KILL', repeating every restart cycle) consistent with unbounded
# growth over time rather than a single request spiking usage. Once _cache
# would exceed this, the oldest-inserted entries are evicted first (FIFO --
# see _cache_set) on the theory that whatever's been sitting longest is
# least likely to be needed again soon. This is a rough proxy for memory
# (entry count, not bytes), not an exact budget -- tune based on real
# `free -h` / RSS numbers once observed.


def _cache_set(key, ttl, value):
    # Every distinct (namespace, query) pair gets its own permanent dict slot
    # once written -- with 41 leagues' worth of teams/players/date-windows
    # now possible, the space of distinct cache keys is large enough that
    # entries were never being evicted, only overwritten if the exact same
    # key came up again. Over a long-running process that grows without
    # bound. A cheap periodic sweep of anything already past its own TTL
    # keeps steady-state memory bounded to "what's still live" instead of
    # "everything ever computed" -- and the hard cap below (_CACHE_MAX_ENTRIES)
    # backstops that with a bound that doesn't depend on TTLs actually expiring.
    global _cache_writes_since_sweep
    # Pop before re-inserting so a re-written key always moves to the end --
    # otherwise a plain dict would leave it in its original insertion
    # position, and "oldest inserted" (used for FIFO eviction below) would
    # stop meaning "least recently touched" for any key that gets refreshed.
    _cache.pop(key, None)
    _cache[key] = (time.time() + ttl, value)
    _cache_writes_since_sweep += 1
    if _cache_writes_since_sweep >= _CACHE_SWEEP_EVERY:
        _cache_writes_since_sweep = 0
        now = time.time()
        for k in [k for k, (expires_at, _) in _cache.items() if expires_at <= now]:
            del _cache[k]
    while len(_cache) > _CACHE_MAX_ENTRIES:
        _cache.popitem(last=False)


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
DEPLOY_WEBHOOK_SECRET = os.environ.get("DEPLOY_WEBHOOK_SECRET", "")

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


def fetch_all_events_windowed(params, cache_ns, ttl, earliest_iso, window_days=30, max_workers=6):
    """Team-scoped variant of fetch_all_events that fans out across date
    windows in parallel instead of walking the cursor sequentially one page
    at a time. Cursor pagination can't be parallelized (each page's cursor
    depends on the previous response), but independent date ranges can --
    for a high-volume league (MLB especially) walking 10+ pages one at a
    time was slow enough to occasionally get cut off before finishing.

    max_workers is deliberately modest (was 20 briefly, dropped after a
    real incident): this fan-out happens PER incoming /api/game-log
    request, and the client already runs up to MINI_FORM_CONCURRENCY (4) of
    those concurrently for a page full of prop cards. Right after a service
    restart -- which wipes this entire in-memory cache, including every
    previously-warm game-log entry -- that's up to 4 * max_workers
    concurrent outbound connections from a single small VM, all cold, all
    at once. At 20 workers that was 80 concurrent connections during
    exactly the moment the process was most fragile (just after
    restarting), and requests were observed getting cut off mid-response as
    a result (client-side 'Unexpected end of JSON input' on most/all prop
    cards simultaneously). 6 keeps most of the parallel speedup over a
    fully sequential walk while capping the worst case at a much more
    survivable ~24 concurrent connections.
    """
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


GAME_STARTED_CUTOFF_MINUTES = 60
# MLB/KBO Matchups' own game pickers still want an already-started game to
# stay pickable (e.g. to check history mid-game) rather than disappearing
# the instant it tips off, unlike the main Markets grid's tighter cutoff
# above -- but genuinely stale, multi-day-old leftovers (e.g. a KBO game
# from 3 days ago still showing odds-available upstream) shouldn't stay
# pickable indefinitely either. 24h is generous enough to cover a same-day
# in-progress game (including a long KBO doubleheader night) while dropping
# anything from a prior day.
MATCHUP_PICKER_STARTED_CUTOFF_MINUTES = 24 * 60


def _game_started_too_long_ago(starts_at_iso, cutoff_minutes=GAME_STARTED_CUTOFF_MINUTES):
    """True once a game's own start time is more than cutoff_minutes in the
    past. Used to drop stale games from /api/markets: the main Markets grid
    and Best No-Vig use the tight default (GAME_STARTED_CUTOFF_MINUTES,
    since once a game's well underway its pre-game odds/props are stale and
    not worth continuing to serve), while the MLB/KBO Matchups game pickers
    pass the looser MATCHUP_PICKER_STARTED_CUTOFF_MINUTES instead -- see
    build_markets and handle_markets.
    """
    if not starts_at_iso:
        return False
    try:
        starts_at = datetime.datetime.fromisoformat(starts_at_iso.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return False
    return (datetime.datetime.now(datetime.timezone.utc) - starts_at) > datetime.timedelta(minutes=cutoff_minutes)


KBO_RECENT_GAMES_LOOKBACK_HOURS = 30
# Long enough to cover a full KBO game day (evening KST first pitch through
# a late finish, extra innings, or a doubleheader) even accounting for the
# UTC/KST offset, without reaching back far enough to surface yesterday's
# games too.


def build_kbo_recent_games(events):
    """Lightweight team/matchup discovery for the KBO Matchups game picker,
    covering games whose betting markets have already closed (SportsGameOdds
    stops returning a game from the oddsAvailable=true query the moment its
    market settles, typically right after the game ends -- so /api/markets
    alone can't surface 'today's already-played KBO games' no matter how
    generous our own started-too-long-ago cutoff is; the event itself simply
    isn't in that query's response anymore). Unlike build_markets, this only
    needs team names + start time -- no odds data required -- so it works
    against a finalized=true query instead."""
    seen = {}
    for event in events:
        teams = event.get("teams") or {}
        home = _resolve_kbo_team_display(team_short_name(teams.get("home")))
        away = _resolve_kbo_team_display(team_short_name(teams.get("away")))
        starts_at = (event.get("status") or {}).get("startsAt")
        if not starts_at:
            continue
        matchup = f"{away} @ {home}"
        seen[f"{matchup}|{starts_at}"] = {"matchup": matchup, "startsAt": starts_at}
    return list(seen.values())


def build_markets(events, started_cutoff_minutes=GAME_STARTED_CUTOFF_MINUTES):
    """started_cutoff_minutes controls how far in the past a game's start
    time can be before it's dropped as stale (see _game_started_too_long_ago).
    The main Markets grid and Best No-Vig use the tight default -- once a
    game's well underway its pre-game props aren't worth showing or
    fetching mini-form data for. MLB/KBO Matchups' own game pickers pass
    the looser MATCHUP_PICKER_STARTED_CUTOFF_MINUTES instead: those tabs
    still want an already-started game pickable for a while (e.g. to check
    history mid-game), just not one that's days stale.
    """
    items = []
    for event in events:
        teams = event.get("teams") or {}
        home = team_short_name(teams.get("home"))
        away = team_short_name(teams.get("away"))
        if event.get("leagueID") == "KBO":
            # SportsGameOdds sometimes sends short/abbreviated KBO team
            # strings (e.g. 'GIA', 'BEA') rather than full names -- resolve
            # through the same matcher build_kbo_matchup uses, so the
            # Markets grid and the KBO Matchups game picker (built from
            # these same matchup strings) show full names consistently.
            home = _resolve_kbo_team_display(home)
            away = _resolve_kbo_team_display(away)
        matchup = f"{away} @ {home}"
        starts_at = (event.get("status") or {}).get("startsAt")
        if _game_started_too_long_ago(starts_at, started_cutoff_minutes):
            continue
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

        # Final score, when available -- independent of player_id/stat_id,
        # since the game's own score lives at the event level regardless of
        # which player or team stat this particular chart is about. Powers
        # the chart tooltip's "TEX 5 : 2 LAD"-style line; None on either side
        # just means the tooltip omits the score rather than failing.
        home_pts = (game_results.get("home") or {}).get("points")
        away_pts = (game_results.get("away") or {}).get("points")
        own_score, opponent_score = (home_pts, away_pts) if is_home else (away_pts, home_pts)

        if player_id:
            player_line = game_results.get(player_id)
            if not player_line or stat_id not in player_line:
                continue
            stat_value = player_line[stat_id]
        elif stat_id in TEAM_STAT_IDS:
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
        own_team = teams.get("home") if is_home else teams.get("away")
        games.append({
            "eventID": event["eventID"],
            "date": starts_at,
            "home": is_home,
            "opponentTeamID": (opp_team or {}).get("teamID"),
            "opponentName": team_short_name(opp_team),
            "ownName": team_short_name(own_team),
            "ownScore": own_score,
            "opponentScore": opponent_score,
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


MLB_RECENT_SEASONS_WINDOW = 3  # "recent" = the batter's last 3 individual MLB seasons vs this pitcher, not last-3-calendar-years -- see get_batter_vs_pitcher


def _sum_hitting_splits(splits):
    """Shared aggregation for career/recent views across BOTH vs-pitcher and
    vs-team splits (see get_batter_vs_pitcher and get_batter_vs_team) --
    OPS/AVG/SLG aren't valid to average across seasons, so this always sums
    the raw counting stats first and recomputes the rate stats from those
    totals, never from a per-split rate stat directly. Includes runs/rbi
    (not just the original AVG/OBP/SLG/OPS-oriented set) since the MLB
    Matchups player-card modal's stat tabs (Runs, RBI's, H+R+RBI) need them."""
    if not splits:
        return None
    totals = {"atBats": 0, "hits": 0, "runs": 0, "rbi": 0, "homeRuns": 0, "baseOnBalls": 0, "strikeOuts": 0, "totalBases": 0, "hitByPitch": 0, "sacFlies": 0, "plateAppearances": 0}
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
        "atBats": ab, "hits": h, "runs": totals["runs"], "rbi": totals["rbi"],
        "homeRuns": totals["homeRuns"], "walks": bb, "strikeouts": totals["strikeOuts"],
        "plateAppearances": pa, "avg": avg, "obp": obp, "slg": slg, "ops": ops,
    }


def get_batter_vs_pitcher(batter_id, pitcher_id):
    """Two views of a batter's history against one specific pitcher, both
    built from the same request: "career" (MLB's own precomputed lifetime
    total -- the 'vsPlayerTotal' block) and "recent" (this batter's last
    MLB_RECENT_SEASONS_WINDOW individual seasons they've faced this pitcher
    in at all, summed from the 'vsPlayer' season-by-season block -- NOT the
    last N calendar years, since a batter/pitcher pair can go years between
    meetings, e.g. after a trade). Confirmed by hand against the raw API
    response for Salvador Perez vs. Max Scherzer: the two blocks are
    internally consistent (summing every season in 'vsPlayer' reproduces
    'vsPlayerTotal' exactly) -- this was a real user-reported discrepancy
    against a different source that turned out to be that source only
    covering a recent subset of a much longer head-to-head history, not a
    bug in this aggregation."""
    url = (
        f"{MLB_STATS_BASE}/people/{batter_id}/stats"
        f"?stats=vsPlayer&opposingPlayerId={pitcher_id}&group=hitting"
    )
    data = _fetch_mlb_json(url, cache_ns="mlb_vsplayer", ttl=MLB_VSPLAYER_CACHE_TTL)
    stats_blocks = data.get("stats") or []

    def block_splits(type_name):
        return next((b.get("splits") or [] for b in stats_blocks if (b.get("type") or {}).get("displayName") == type_name), [])

    career_splits = block_splits("vsPlayerTotal")
    season_splits = block_splits("vsPlayer")
    # Season strings sort correctly as plain strings ("2011" < "2024"), no
    # int conversion needed. Only seasons this pair actually met in count
    # toward the "last N" window -- a season with no meeting is just absent
    # from season_splits, not a zero-stat entry.
    recent_seasons = sorted({s.get("season") for s in season_splits if s.get("season")}, reverse=True)[:MLB_RECENT_SEASONS_WINDOW]
    recent_splits = [s for s in season_splits if s.get("season") in recent_seasons]

    career = _sum_hitting_splits(career_splits)
    recent = _sum_hitting_splits(recent_splits)
    if career is None and recent is None:
        return None
    return {"career": career, "recent": recent, "recentSeasons": recent_seasons}


MLB_VSTEAM_CACHE_TTL = 24 * 60 * 60
MLB_SEASON_STATS_CACHE_TTL = 6 * 60 * 60  # season totals move daily during the season
MLB_GAMELOG_CACHE_TTL = 6 * 60 * 60


def get_batter_vs_team(batter_id, opposing_team_statsapi_id):
    """Same shape and approach as get_batter_vs_pitcher just above, but
    against an entire opposing team's pitching staff rather than one
    specific starter -- MLB's 'vsTeam'/'vsTeamTotal' split types, following
    the exact same opposingTeamId-style query param convention as
    get_batter_vs_pitcher's opposingPlayerId. Powers the MLB Matchups player
    card modal's 'Head 2 Head' tab (as opposed to 'Head 2 Head vs Pitcher',
    which stays on get_batter_vs_pitcher/vsPlayer)."""
    url = (
        f"{MLB_STATS_BASE}/people/{batter_id}/stats"
        f"?stats=vsTeam&opposingTeamId={opposing_team_statsapi_id}&group=hitting"
    )
    data = _fetch_mlb_json(url, cache_ns="mlb_vsteam", ttl=MLB_VSTEAM_CACHE_TTL)
    stats_blocks = data.get("stats") or []

    def block_splits(type_name):
        return next((b.get("splits") or [] for b in stats_blocks if (b.get("type") or {}).get("displayName") == type_name), [])

    career_splits = block_splits("vsTeamTotal")
    season_splits = block_splits("vsTeam")
    recent_seasons = sorted({s.get("season") for s in season_splits if s.get("season")}, reverse=True)[:MLB_RECENT_SEASONS_WINDOW]
    recent_splits = [s for s in season_splits if s.get("season") in recent_seasons]

    career = _sum_hitting_splits(career_splits)
    recent = _sum_hitting_splits(recent_splits)
    if career is None and recent is None:
        return None
    return {"career": career, "recent": recent, "recentSeasons": recent_seasons}


def _parse_rate(v):
    """MLB's season-stats endpoint returns rate stats as pre-formatted
    strings like '.275' (no leading zero) rather than numbers -- Python's
    float() parses that fine directly, this just guards the sentinel/blank
    values the API uses for 'no at-bats yet' (None, '', '-', '.---')."""
    if v in (None, "", "-", ".---"):
        return None
    try:
        return round(float(v), 3)
    except (TypeError, ValueError):
        return None


def get_batter_season_stats(batter_id, season):
    """One full-season hitting line -- powers the player card modal's
    '{year} Season' view tabs."""
    url = f"{MLB_STATS_BASE}/people/{batter_id}/stats?stats=season&season={season}&group=hitting"
    data = _fetch_mlb_json(url, cache_ns="mlb_season", ttl=MLB_SEASON_STATS_CACHE_TTL)
    stats_blocks = data.get("stats") or []
    splits = next((b.get("splits") or [] for b in stats_blocks if (b.get("type") or {}).get("displayName") == "season"), [])
    if not splits:
        return None
    stat = splits[0].get("stat") or {}
    return {
        "atBats": stat.get("atBats") or 0,
        "hits": stat.get("hits") or 0,
        "runs": stat.get("runs") or 0,
        "rbi": stat.get("rbi") or 0,
        "homeRuns": stat.get("homeRuns") or 0,
        "walks": stat.get("baseOnBalls") or 0,
        "strikeouts": stat.get("strikeOuts") or 0,
        "plateAppearances": stat.get("plateAppearances") or 0,
        "avg": _parse_rate(stat.get("avg")),
        "obp": _parse_rate(stat.get("obp")),
        "slg": _parse_rate(stat.get("slg")),
        "ops": _parse_rate(stat.get("ops")),
    }


def get_batter_game_log(batter_id, season):
    """Most-recent-first per-game hitting log for one season -- the player
    card modal's Last 5/10/20 view tabs are just the head of this same list,
    sliced client-side rather than three separate fetches (same 'fetch once,
    slice for every window' pattern as the KBO batter game log above)."""
    url = f"{MLB_STATS_BASE}/people/{batter_id}/stats?stats=gameLog&season={season}&group=hitting"
    data = _fetch_mlb_json(url, cache_ns="mlb_gamelog", ttl=MLB_GAMELOG_CACHE_TTL)
    stats_blocks = data.get("stats") or []
    splits = next((b.get("splits") or [] for b in stats_blocks if (b.get("type") or {}).get("displayName") == "gameLog"), [])
    games = []
    for s in splits:
        stat = s.get("stat") or {}
        games.append({
            "date": s.get("date"),
            "opponent": (s.get("opponent") or {}).get("name"),
            "atBats": stat.get("atBats") or 0,
            "hits": stat.get("hits") or 0,
            "runs": stat.get("runs") or 0,
            "rbi": stat.get("rbi") or 0,
            "homeRuns": stat.get("homeRuns") or 0,
            "walks": stat.get("baseOnBalls") or 0,
            "strikeouts": stat.get("strikeOuts") or 0,
            "plateAppearances": stat.get("plateAppearances") or 0,
        })
    games.sort(key=lambda g: g["date"] or "", reverse=True)
    return games


def build_mlb_player_splits(batter_id, pitcher_id, opponent_team_key):
    """Everything the MLB Matchups player-card modal needs for one batter,
    fetched in one shot when a card is clicked (not eagerly for every
    batter in a lineup, mirroring the lazy-on-open pattern the Markets
    tab's modal already uses for its own Recent Form section). Each of the
    four data sources is independently wrapped -- one source failing (e.g.
    a rookie with no prior-season splits) shouldn't blank out the rest."""
    opponent_statsapi_id = MLB_TEAM_STATSAPI_ID.get(opponent_team_key) if opponent_team_key else None
    current_year = datetime.datetime.now().year

    vs_team = None
    if opponent_statsapi_id:
        try:
            vs_team = get_batter_vs_team(batter_id, opponent_statsapi_id)
        except UpstreamError as e:
            print(f"[vantage] mlb-player-splits: vsTeam failed for batter {batter_id}: {e.message}")

    vs_pitcher = None
    if pitcher_id:
        try:
            vs_pitcher = get_batter_vs_pitcher(batter_id, pitcher_id)
        except UpstreamError as e:
            print(f"[vantage] mlb-player-splits: vsPitcher failed for batter {batter_id}: {e.message}")

    games = []
    try:
        games = get_batter_game_log(batter_id, current_year)
    except UpstreamError as e:
        print(f"[vantage] mlb-player-splits: gameLog failed for batter {batter_id}: {e.message}")

    seasons = []
    for year in (current_year, current_year - 1):
        try:
            stats = get_batter_season_stats(batter_id, year)
        except UpstreamError as e:
            print(f"[vantage] mlb-player-splits: season {year} failed for batter {batter_id}: {e.message}")
            stats = None
        seasons.append({"year": year, "stats": stats})

    return {
        "vsTeam": vs_team,
        "vsPitcher": vs_pitcher,
        "games": games,
        "seasons": seasons,
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
        # career/recent can each independently be None (e.g. a batter who's
        # only recently come up won't have any pre-MLB_RECENT_SEASONS_WINDOW
        # meetings, but could still have a career total if they faced this
        # pitcher in the minors -- unlikely but keep the sort key defensive).
        def sort_key(r):
            career = r["stats"]["career"]
            return career["atBats"] if career else 0
        rows.sort(key=sort_key, reverse=True)
        return {"pitcher": pitcher, "batters": rows}

    return {
        # Home team's pitcher faces the away team's lineup, and vice versa.
        "homePitcherVsAwayHitters": side_matchups(pitchers["home"], get_active_hitters(away_statsapi_id)),
        "awayPitcherVsHomeHitters": side_matchups(pitchers["away"], get_active_hitters(home_statsapi_id)),
    }


# =====================================================================
# KBO batter-vs-opponent matchups (mykbostats.com)
# =====================================================================
# Unlike the MLB matchup feature above, there's no public KBO stats API --
# this scrapes mykbostats.com, a fan-run site. Two structural differences
# from the MLB approach follow directly from that:
#
# 1. NEW DEPENDENCY: mykbostats.com 403s plain urllib/requests calls (basic
#    bot-protection) -- a bare request works for MLB's Stats API but not
#    here. `cloudscraper` gets past it (see requirements.txt). This is the
#    one exception to this file's stdlib-only design; everything else below
#    (HTML table extraction) is still hand-rolled with `re` rather than
#    adding BeautifulSoup too, to keep the new dependency surface as small
#    as this genuinely requires.
# 2. NO PER-PITCHER SPLITS: mykbostats.com has no batter-vs-specific-pitcher
#    data (confirmed by hand during manual research -- koreabaseball.com
#    blocks bots outright, Statiz.co.kr is JS-only, and mykbostats itself
#    only tracks batter-vs-TEAM splits). So this feature is *only*
#    "batters vs. opponent team", built the same way as the matching tab in
#    the KBO Excel workbook tool: pull each batter's own season game log and
#    sum the games played against that specific opponent. There's no
#    "vs. today's probable starter" version to build here, structurally.
#
# This also means, unlike MLB's live probable-pitcher lookup, there's no
# same-day freshness requirement -- each batter's own page already carries
# whatever games mykbostats has logged for them, updated on their own
# schedule. No play-by-play reconstruction happens here (that's a manual/
# judgment step for building one specific day's spreadsheet, not something
# this always-on endpoint attempts) -- so a batter's very latest game may or
# may not be reflected yet, same staleness tradeoff as any other stats
# source that isn't hand-verified.

MYKBO_BASE = "https://mykbostats.com"
KBO_ROSTER_CACHE_TTL = 26 * 60 * 60
# 26h, not the on-demand default of 6h -- once the once-daily pre-warm job
# (below, timed for right after games finish) is populating this cache on
# its own schedule, the TTL needs to comfortably outlive the ~24h gap
# between cycles (plus the cycle's own runtime) or entries would expire and
# fall back to live on-demand fetches during the day anyway, defeating the
# point.
KBO_GAMELOG_CACHE_TTL = 26 * 60 * 60

# team display name (as it appears in SportsGameOdds' KBO matchup strings)
# -> mykbostats.com numeric team id + URL slug + the 2-3 letter "Opp" code
# mykbostats uses in a batter's own game log to mark who they played.
# IDs/slugs confirmed by hand against mykbostats.com; if a team's slug ever
# changes there this mapping will need a one-line update.
KBO_TEAM_ROSTER = {
    "Kia Tigers":      {"id": 5,  "slug": "Kia-Tigers",      "oppCode": "KIA"},
    "Kiwoom Heroes":   {"id": 23, "slug": "Kiwoom-Heroes",   "oppCode": "KIW"},
    "KT Wiz":          {"id": 22, "slug": "KT-Wiz",          "oppCode": "KT"},
    "SSG Landers":     {"id": 24, "slug": "SSG-Landers",     "oppCode": "SSG"},
    "LG Twins":        {"id": 6,  "slug": "LG-Twins",        "oppCode": "LG"},
    "Hanwha Eagles":   {"id": 4,  "slug": "Hanwha-Eagles",   "oppCode": "HAN"},
    "Lotte Giants":    {"id": 2,  "slug": "Lotte-Giants",    "oppCode": "LOT"},
    "Doosan Bears":    {"id": 1,  "slug": "Doosan-Bears",    "oppCode": "DOO"},
    "Samsung Lions":   {"id": 3,  "slug": "Samsung-Lions",   "oppCode": "SAM"},
    "NC Dinos":        {"id": 9,  "slug": "NC-Dinos",        "oppCode": "NC"},
}

_kbo_scraper_lock = threading.Lock()
_kbo_scraper = None
_kbo_scraper_warmed_up = False


def _get_kbo_scraper():
    """Lazily creates one shared cloudscraper session for the process
    (mirrors the warm-up-then-reuse pattern that worked in testing -- a
    bare first request 403s, but visiting the homepage once first to pick
    up a normal session cookie, then reusing that same session, gets
    through). Thread-safe since KBO matchup building fans out across a
    thread pool."""
    global _kbo_scraper, _kbo_scraper_warmed_up
    with _kbo_scraper_lock:
        if _kbo_scraper is None:
            import cloudscraper
            _kbo_scraper = cloudscraper.create_scraper()
        if not _kbo_scraper_warmed_up:
            _kbo_scraper.get(MYKBO_BASE + "/", timeout=20)
            _kbo_scraper_warmed_up = True
        return _kbo_scraper


def _fetch_mykbo_html(url, cache_ns, ttl):
    cache_key = f"{cache_ns}:{url}"
    cached = _cache.get(cache_key)
    if cached and cached[0] > time.time():
        return cached[1]

    scraper = _get_kbo_scraper()
    resp = scraper.get(url, timeout=20)
    # 403 = the bot-protection challenge itself; 429 = we're past that but
    # mykbostats' own rate limiter kicked in (seen in testing when switching
    # between several different games in quick succession, each pulling a
    # fresh roster + ~9-13 player pages). A single retry wasn't always
    # enough during heavy back-to-back testing across many different teams,
    # so 429 gets two retries with increasing backoff (a fresh team's ~10
    # player pages can still be mid-flight on other threads when the first
    # retry lands); 403 keeps its original single retry since that's a one-
    # time challenge, not an ongoing rate window.
    if resp.status_code == 403:
        time.sleep(3)
        resp = scraper.get(url, timeout=20)
    elif resp.status_code == 429:
        for backoff in (8, 15):
            time.sleep(backoff)
            resp = scraper.get(url, timeout=20)
            if resp.status_code != 429:
                break
    if resp.status_code != 200:
        raise UpstreamError(resp.status_code, f"mykbostats.com returned {resp.status_code} for {url}")

    html_text = resp.text
    _cache_set(cache_key, ttl, html_text)
    return html_text


def _strip_tags(cell_html):
    """Cell text with any nested tags removed and HTML entities decoded --
    good enough for mykbostats' fairly plain table cells (no nested tables,
    just occasional links/spans around plain text)."""
    text = re.sub(r"<[^>]+>", "", cell_html)
    return html.unescape(text).strip()


def _find_table_by_header_substrings(page_html, required_substrings):
    """Hand-rolled substitute for BeautifulSoup's find-table-by-header-text
    (see kbo_scraper.py's identically-named helper, which this mirrors).
    Scans each <table>...</table> block, and returns the first one whose
    <th> row contains every required substring (case-insensitive). Returns
    the raw HTML of that table, or None."""
    for match in re.finditer(r"<table\b.*?</table>", page_html, re.DOTALL | re.IGNORECASE):
        table_html = match.group(0)
        headers = " | ".join(_strip_tags(h) for h in re.findall(r"<th\b.*?</th>", table_html, re.DOTALL | re.IGNORECASE))
        if all(s.upper() in headers.upper() for s in required_substrings):
            return table_html
    return None


def _table_rows(table_html):
    """<table html> -> list of lists of cell text, one list per <tr>
    (header row included as the first entry)."""
    rows = []
    for tr_match in re.finditer(r"<tr\b.*?</tr>", table_html, re.DOTALL | re.IGNORECASE):
        tr_html = tr_match.group(0)
        cells = re.findall(r"<t[hd]\b.*?</t[hd]>", tr_html, re.DOTALL | re.IGNORECASE)
        if cells:
            rows.append([_strip_tags(c) for c in cells])
    return rows


def get_kbo_roster(team_name):
    """team display name -> list of {"id", "fullName"}. Includes every
    player linked from the roster page, pitchers included -- harmless here
    since KBO plays with a universal DH, so a pitcher's own game log simply
    never has any batting rows and will fall out naturally when we filter
    to players with at-bats against the opponent, no separate pitcher
    exclusion needed (unlike the MLB roster helper above, which explicitly
    skips position == "P")."""
    team = KBO_TEAM_ROSTER.get(team_name)
    if not team:
        return []
    cache_key = f"kbo_roster_parsed:{team_name}"
    cached = _cache.get(cache_key)
    if cached and cached[0] > time.time():
        return cached[1]

    url = f"{MYKBO_BASE}/teams/{team['id']}-{team['slug']}"
    page_html = _fetch_mykbo_html(url, cache_ns="kbo_roster_html", ttl=KBO_ROSTER_CACHE_TTL)

    seen = {}
    for m in re.finditer(r'<a[^>]+href="/players/(\d+)[^"]*"[^>]*>([^<]+)</a>', page_html):
        player_id, name = m.group(1), html.unescape(m.group(2)).strip()
        if name:
            seen[player_id] = name
    roster = [{"id": pid, "fullName": name} for pid, name in seen.items()]
    _cache_set(cache_key, KBO_ROSTER_CACHE_TTL, roster)
    return roster


def _aggregate_games(games):
    """list of game dicts -> counting-stat totals plus rate stats, or None
    if the list is empty (no at-bats in this window -- covers both a batter
    genuinely having fewer than N games played and pitcher ids that never
    bat). OBP here omits sacrifice flies from the denominator -- mykbostats'
    game log table doesn't carry a SF column -- so it's a close approximation
    of the real stat, not an exact match to official KBO OBP."""
    if not games:
        return None
    totals = {"atBats": 0, "hits": 0, "runs": 0, "rbi": 0, "homeRuns": 0, "doubles": 0, "triples": 0, "walks": 0, "hitByPitch": 0}
    for g in games:
        totals["atBats"] += g["ab"]
        totals["hits"] += g["h"]
        totals["runs"] += g["r"]
        totals["rbi"] += g["rbi"]
        totals["homeRuns"] += g["hr"]
        totals["doubles"] += g["doubles"]
        totals["triples"] += g["triples"]
        totals["walks"] += g["bb"]
        totals["hitByPitch"] += g["hbp"]
    totals["gamesFound"] = len(games)
    ab, h, bb, hbp = totals["atBats"], totals["hits"], totals["walks"], totals["hitByPitch"]
    total_bases = h + totals["doubles"] + 2 * totals["triples"] + 3 * totals["homeRuns"]
    obp_denom = ab + bb + hbp
    totals["avg"] = round(h / ab, 3) if ab else None
    totals["obp"] = round((h + bb + hbp) / obp_denom, 3) if obp_denom else None
    totals["slg"] = round(total_bases / ab, 3) if ab else None
    totals["ops"] = round(totals["obp"] + totals["slg"], 3) if (totals["obp"] is not None and totals["slg"] is not None) else None
    return totals


def _get_kbo_player_games(player_id):
    """One batter's full logged game list this season, oldest-first (matches
    mykbostats' own table order) -- the shared raw material both the
    vs-opponent aggregate and the L5/L10/L20 recent-form aggregates are
    built from, fetched and parsed once per player regardless of how many
    different views need it."""
    cache_key = f"kbo_gamelog_parsed:{player_id}"
    cached = _cache.get(cache_key)
    if cached and cached[0] > time.time():
        return cached[1]

    url = f"{MYKBO_BASE}/players/{player_id}"
    page_html = _fetch_mykbo_html(url, cache_ns="kbo_player_html", ttl=KBO_GAMELOG_CACHE_TTL)
    table_html = _find_table_by_header_substrings(page_html, ["DATE", "AB", "RBI"])
    games = []
    if table_html:
        rows = _table_rows(table_html)
        # mykbostats' own column order, confirmed by hand against many
        # player pages: Date, Opp, AB, R, H, 2B, 3B, HR, RBI, BB, HBP.
        # Parsed by fixed position rather than re-matching header text
        # per row, since that order has been consistent everywhere it's
        # been checked -- if mykbostats ever reorders these columns,
        # this needs updating to match (see kbo_scraper.py's equivalent
        # note).
        for row in rows[1:]:  # skip header row
            if len(row) < 11:
                continue
            date_str, opp = row[0], row[1]
            try:
                ab, r, h = int(row[2]), int(row[3]), int(row[4])
                doubles, triples, hr, rbi = int(row[5]), int(row[6]), int(row[7]), int(row[8])
                bb, hbp = int(row[9]), int(row[10])
            except ValueError:
                continue  # a totals/subtotal row, or a blank cell -- skip
            games.append({
                "date": date_str, "opp": opp, "ab": ab, "r": r, "h": h, "hr": hr, "rbi": rbi,
                "doubles": doubles, "triples": triples, "bb": bb, "hbp": hbp,
            })
    _cache_set(cache_key, KBO_GAMELOG_CACHE_TTL, games)
    return games


def get_kbo_batter_stats(player_id, opponent_code):
    """One batter's stats in four views, all built from the same fetched
    game log: career at-bats against opponent_code (vsOpponent, an
    aggregate total -- season-long history against one team is naturally a
    summary, not a short list), plus last-5/10/20-games recent form
    regardless of opponent, each returned as the actual individual games
    (oldest-first) rather than combined into one totals line -- mirrors the
    'Last 5-10-20 Games' tab from the original KBO Excel workbook tool,
    which was paused there but is a natural fit here since the per-batter
    game log is already being fetched for the vs-opponent view. Each
    last-N view also carries its own "aggregate" (used for sorting batters
    within a team) alongside the per-game "games" list (used for display).
    Returns None only if every one of the four views comes back empty --
    covers a pitcher id that never bats, so it's dropped from the matchup
    entirely; a real batter who simply hasn't faced this opponent yet
    still shows up with vsOpponent: None but real L5/L10/L20 games."""
    games = _get_kbo_player_games(player_id)
    vs_opponent = _aggregate_games([g for g in games if opponent_code in g["opp"].upper()])

    def recent_window(n):
        # games list is oldest-first, so "last N" is the tail slice, then
        # reversed so the display order is most-recent-first (matches how
        # the vsOpponent-style summaries and the Excel Game Log tab both
        # read most naturally).
        window_games = list(reversed(games[-n:]))
        return {
            "aggregate": _aggregate_games(window_games),
            "games": [
                {"date": g.get("date"), "opp": g["opp"], "ab": g["ab"], "h": g["h"],
                 "r": g["r"], "rbi": g["rbi"], "hr": g["hr"]}
                for g in window_games
            ],
        }

    last5 = recent_window(5)
    last10 = recent_window(10)
    last20 = recent_window(20)
    if vs_opponent is None and not last5["games"] and not last10["games"] and not last20["games"]:
        return None
    return {"vsOpponent": vs_opponent, "last5": last5, "last10": last10, "last20": last20}


def _resolve_kbo_team(name):
    """Exact match first, then case-insensitive, then substring, since
    there's no confirmed guarantee that SportsGameOdds' KBO team display
    strings (used to discover today's games) exactly match mykbostats.com's
    own naming -- this hasn't been tested against SportsGameOdds' actual
    KBO output. If this raises, the error message includes the exact string
    that failed to match so a naming mismatch is fast to spot and fix by
    adding an alias to KBO_TEAM_ROSTER."""
    if name in KBO_TEAM_ROSTER:
        return name, KBO_TEAM_ROSTER[name]
    lname = name.lower()
    for key, team in KBO_TEAM_ROSTER.items():
        if key.lower() == lname:
            return key, team
    for key, team in KBO_TEAM_ROSTER.items():
        if key.lower() in lname or lname in key.lower():
            return key, team
    raise UpstreamError(400, f"Unrecognized KBO team name from odds feed: '{name}' -- doesn't match any key in KBO_TEAM_ROSTER, even loosely. Add an alias there.")


def _resolve_kbo_team_display(name):
    """Best-effort version of _resolve_kbo_team for cosmetic display only --
    used to turn whatever short/abbreviated team string SportsGameOdds sent
    (e.g. 'GIA', 'BEA') into the full name (e.g. 'Lotte Giants', 'Doosan
    Bears') everywhere a KBO matchup label is shown: the Markets grid's card
    names, and the KBO Matchups tab's own game picker (which is built from
    Markets' Moneyline items -- see fetchKboGames in kbo.js). Unlike
    _resolve_kbo_team, this never raises: an unrecognized name just displays
    as-is rather than taking down the whole /api/markets response over one
    KBO team's cosmetic label. The actual KBO Matchups data fetch (once a
    game is picked) still goes through the raising _resolve_kbo_team inside
    build_kbo_matchup, so a genuine unmatched-team bug still surfaces there
    with its usual clear error rather than being silently swallowed."""
    try:
        resolved_name, _ = _resolve_kbo_team(name)
        return resolved_name
    except UpstreamError:
        return name


def build_kbo_matchup(home_team, away_team):
    home_team, home = _resolve_kbo_team(home_team)
    away_team, away = _resolve_kbo_team(away_team)

    def fetch_one(p, opponent_code):
        # A small fixed stagger before each request, on top of the small
        # worker pool below -- seen in testing: switching between several
        # different KBO games in quick succession (each needing a fresh
        # roster + ~9-13 uncached player pages) was enough to trip
        # mykbostats' own 429 rate limit, separate from the 403 bot-check
        # cloudscraper already handles. This trades a bit of latency for
        # reliability against a small fan-run site that was never built to
        # take bursty concurrent traffic.
        time.sleep(0.3)
        try:
            return p, get_kbo_batter_stats(p["id"], opponent_code)
        except UpstreamError as e:
            # One player hitting a 429/403 that survives the retries inside
            # _fetch_mykbo_html shouldn't take down the whole matchup card --
            # seen in production on this server's very first-ever KBO request
            # (a cold IP mykbostats hadn't seen traffic from before). Skip
            # just this player (their row won't appear) and let the rest of
            # the roster's already-successful/cached fetches still return.
            print(f"[vantage] KBO matchup: {p.get('fullName')} (id {p.get('id')}) failed: {e.message}")
            return p, None

    def side_batters(roster_team_name, opponent_code):
        try:
            roster = get_kbo_roster(roster_team_name)
        except UpstreamError as e:
            # Same reasoning as fetch_one below: a roster-page fetch failing
            # (rate limit, transient bot-check) shouldn't take down the
            # whole matchup response -- return this side as empty rather
            # than erroring the other team's side out too.
            print(f"[vantage] KBO matchup: {roster_team_name} roster failed: {e.message}")
            return []
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda p: fetch_one(p, opponent_code), roster))
        rows = [{**p, "stats": s} for p, s in results if s is not None]
        # vsOpponent can now legitimately be None for a real batter who just
        # hasn't faced this team yet (they'd still have L5/L10/L20 data) --
        # sort by vsOpponent at-bats when present, falling back to last20's
        # at-bats so those rows don't all clump arbitrarily at the bottom.
        def sort_key(r):
            vs = r["stats"]["vsOpponent"]
            if vs is not None:
                return (1, vs["atBats"])
            l20 = r["stats"]["last20"]["aggregate"]
            return (0, l20["atBats"] if l20 else 0)
        rows.sort(key=sort_key, reverse=True)
        return rows

    return {
        # Resolved full names (e.g. "Kia Tigers"), not whatever short code
        # the odds feed happened to send (e.g. "TIG") -- the frontend uses
        # these for display so a team-name abbreviation upstream doesn't
        # leak into the UI even though _resolve_kbo_team already handled it
        # internally for the actual data lookup.
        "homeTeamName": home_team,
        "awayTeamName": away_team,
        "homeBattersVsAway": side_batters(home_team, away["oppCode"]),
        "awayBattersVsHome": side_batters(away_team, home["oppCode"]),
    }


KST = datetime.timezone(datetime.timedelta(hours=9))
# 11pm KST -- KBO games start 6-7pm KST and normally finish by 9:30-10:30pm;
# this pads well past that for extra innings, doubleheaders, or a late
# start, without waiting so long that "right after games finish" stops
# being true. There's no live game-status check here (that would mean more
# scraping just to time the scraping) -- this is a fixed clock time chosen
# to reliably fall after the day's games, not a dynamic "are they done yet"
# poll.
KBO_PREWARM_HOUR_KST = 23
KBO_PREWARM_TEAM_DELAY = 20  # seconds paused between teams
KBO_PREWARM_PLAYER_DELAY = 1.0  # seconds paused between each player within a team


def prewarm_kbo_cache():
    """Refreshes every KBO team's roster + every player's game log, once a
    day right after games finish (see refresh_kbo_prewarm_loop) -- so a
    live KBO Matchups click almost always hits the already-warm cache
    instead of triggering the real scrape on the spot. This is deliberately
    slower and gentler than the on-demand path (a full 20s pause between
    teams, a full 1s pause between players, vs. on-demand's 0.3s stagger
    and 2-worker pool): nothing is waiting on a background job, so there's
    no reason to rush it and risk tripping mykbostats' rate limit the way
    rapid manual testing across several teams did earlier. Populates the
    exact same cache entries get_kbo_roster/_get_kbo_player_games already
    read from, so nothing else needs to change to benefit from this
    running."""
    for team_name in KBO_TEAM_ROSTER:
        try:
            roster = get_kbo_roster(team_name)
            for p in roster:
                try:
                    _get_kbo_player_games(p["id"])
                except UpstreamError as e:
                    print(f"[vantage] KBO prewarm: {team_name} - {p.get('fullName')} failed: {e.message}")
                time.sleep(KBO_PREWARM_PLAYER_DELAY)
        except UpstreamError as e:
            print(f"[vantage] KBO prewarm: {team_name} roster failed: {e.message}")
        time.sleep(KBO_PREWARM_TEAM_DELAY)


def _seconds_until_next_kbo_prewarm():
    now = datetime.datetime.now(KST)
    target = now.replace(hour=KBO_PREWARM_HOUR_KST, minute=0, second=0, microsecond=0)
    if target <= now:
        target += datetime.timedelta(days=1)
    return (target - now).total_seconds()


def refresh_kbo_prewarm_loop():
    while True:
        wait_s = _seconds_until_next_kbo_prewarm()
        print(f"[vantage] KBO prewarm: next run in {wait_s / 3600:.1f}h (11pm KST, right after games finish)")
        time.sleep(wait_s)
        try:
            prewarm_kbo_cache()
            print("[vantage] KBO prewarm cycle complete")
        except Exception as e:
            print(f"[vantage] KBO prewarm cycle failed: {e}")
        # Sleep past the target minute before recomputing, so a cycle that
        # finishes in under 60s (e.g. everything already cached) can't loop
        # back and immediately re-trigger for the same target time.
        time.sleep(60)


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
        elif parsed.path == "/api/mlb-player-splits":
            self.handle_mlb_player_splits(parsed)
        elif parsed.path == "/api/kbo-matchups":
            self.handle_kbo_matchups(parsed)
        elif parsed.path == "/api/kbo-recent-games":
            self.handle_kbo_recent_games(parsed)
        elif parsed.path == "/api/best-no-vig":
            self.handle_best_no_vig(parsed)
        elif parsed.path == "/api/golf":
            self.handle_golf(parsed)
        else:
            self.handle_static(parsed)

    def do_POST(self):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == "/deploy":
            self.handle_deploy()
        else:
            self.send_response(404)
            self.end_headers()

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
        # Defaults to True (tight cutoff) for the main Markets grid and Best
        # No-Vig. MLB/KBO Matchups' game pickers pass excludeStarted=false to
        # get the looser MATCHUP_PICKER_STARTED_CUTOFF_MINUTES instead --
        # still pickable for a while after a game starts (e.g. to check
        # history mid-game), but not indefinitely, so multi-day-stale
        # leftovers still drop out of the dropdown -- see build_markets.
        exclude_started = (qs.get("excludeStarted") or ["true"])[0].lower() != "false"
        started_cutoff_minutes = GAME_STARTED_CUTOFF_MINUTES if exclude_started else MATCHUP_PICKER_STARTED_CUTOFF_MINUTES
        try:
            data = fetch_events(
                {"leagueID": league_id, "oddsAvailable": "true", "limit": "12"},
                cache_ns="markets",
                ttl=MARKETS_CACHE_TTL,
            )
            items = build_markets(data.get("data") or [], started_cutoff_minutes=started_cutoff_minutes)
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

    def handle_deploy(self):
        """GitHub webhook target: on a push to main, pulls and restarts the
        systemd service. Verifies GitHub's HMAC-SHA256 payload signature so
        this can't be triggered by an arbitrary POST from anyone who finds
        the URL -- the shared secret lives only in .env and the webhook's own
        config, never in git."""
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""

        if not DEPLOY_WEBHOOK_SECRET:
            self.send_json(500, {"error": "DEPLOY_WEBHOOK_SECRET is not set on the server"})
            return

        signature = self.headers.get("X-Hub-Signature-256") or ""
        expected = "sha256=" + hmac.new(DEPLOY_WEBHOOK_SECRET.encode(), body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            self.send_json(401, {"error": "Invalid signature"})
            return

        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            payload = {}
        if payload.get("ref") not in (None, "refs/heads/main"):
            self.send_json(200, {"success": True, "skipped": f"ignoring push to {payload.get('ref')}"})
            return

        self.send_json(200, {"success": True, "deploying": True})
        # The restart kills this very process, so it runs detached with a
        # short delay -- long enough for the response above to actually reach
        # GitHub before systemd tears this process down.
        #
        # pip3 install runs on every deploy, not just when requirements.txt
        # visibly changed -- this is what was missing when cloudscraper was
        # first added for the KBO feature: the auto-deploy pulled the new
        # code but never installed the new dependency, so the live server
        # ran for a while with a working-looking git history but a KBO tab
        # that 502'd on every request (ModuleNotFoundError uncaught inside
        # the request handler). Re-running install unconditionally is cheap
        # once everything's already satisfied (pip no-ops quickly) and means
        # this class of gap can't recur silently.
        subprocess.Popen(
            ["bash", "-c", f"sleep 1 && cd {SCRIPT_DIR} && git pull && pip3 install -q -r requirements.txt --user && sudo systemctl restart vantage"],
            start_new_session=True,
        )

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

    def handle_mlb_player_splits(self, parsed):
        qs = urllib.parse.parse_qs(parsed.query)

        def one(key, default=None):
            return (qs.get(key) or [default])[0]

        batter_id = one("batterID")
        pitcher_id = one("pitcherID")
        opponent_team_id = one("opponentTeamID")

        if not batter_id:
            self.send_json(400, {"success": False, "error": "batterID is required"})
            return

        try:
            result = build_mlb_player_splits(batter_id, pitcher_id, opponent_team_id)
            self.send_json(200, {"success": True, **result})
        except UpstreamError as e:
            self.send_json(e.status if e.status < 600 else 502, {"success": False, "error": e.message})

    def handle_kbo_recent_games(self, parsed):
        if not self.require_api_key():
            return
        try:
            now = datetime.datetime.now(datetime.timezone.utc)
            starts_after = (now - datetime.timedelta(hours=KBO_RECENT_GAMES_LOOKBACK_HOURS)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
            data = fetch_events(
                {"leagueID": "KBO", "finalized": "true", "startsAfter": starts_after, "limit": "50"},
                cache_ns="kbo-recent-games",
                ttl=MARKETS_CACHE_TTL,
            )
            games = build_kbo_recent_games(data.get("data") or [])
            self.send_json(200, {"success": True, "games": games})
        except UpstreamError as e:
            self.send_json(e.status if e.status < 600 else 502, {"success": False, "error": e.message})

    def handle_kbo_matchups(self, parsed):
        qs = urllib.parse.parse_qs(parsed.query)

        def one(key, default=None):
            return (qs.get(key) or [default])[0]

        home_team = one("homeTeam")
        away_team = one("awayTeam")

        if not all([home_team, away_team]):
            self.send_json(400, {"success": False, "error": "homeTeam and awayTeam are required (team display names, e.g. 'Kia Tigers')"})
            return

        try:
            result = build_kbo_matchup(home_team, away_team)
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
        # Without this, browsers can silently cache a GET fetch() response
        # even with no explicit caching headers present -- bit us during KBO
        # testing, where a hard page-refresh reloaded index.html/app.js fresh
        # but a JS-triggered fetch() to an already-seen API URL (same query
        # string) still served a stale cached response instead of hitting
        # this server again. All of this endpoint's actual caching already
        # happens server-side (the _cache dict, with real per-endpoint TTLs)
        # and is intentional; the browser doing its own opportunistic layer
        # on top is not.
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    """Plain ThreadingHTTPServer spawns one new OS thread per incoming
    connection with no ceiling at all -- fine under light load, but combined
    with fetch_all_events_windowed's own internal thread pool (see above),
    a burst of cold-cache /api/game-log requests (e.g. right after a service
    restart wipes the cache, and a page full of prop cards all start
    fetching their mini-form at once) could compound into far more
    concurrent threads than this small VM can comfortably hold, worsening
    exactly the kind of connection-reset/truncated-response failures this
    is meant to prevent. daemon_threads=True (already ThreadingHTTPServer's
    default) means these still don't block process shutdown; this only
    adds an upper bound on how many can run at once, queuing the rest
    briefly via the semaphore rather than spawning unboundedly.
    """
    _connection_semaphore = threading.Semaphore(64)

    def process_request(self, request, client_address):
        self._connection_semaphore.acquire()
        try:
            super().process_request(request, client_address)
        finally:
            self._connection_semaphore.release()


if __name__ == "__main__":
    if not API_KEY:
        print("[vantage] WARNING: SPORTSGAMEODDS_API_KEY not found in environment or .env file.")
    else:
        threading.Thread(target=refresh_best_no_vig_loop, daemon=True).start()
    threading.Thread(target=refresh_golf_loop, daemon=True).start()
    threading.Thread(target=refresh_kbo_prewarm_loop, daemon=True).start()
    server = BoundedThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[vantage] Serving on http://localhost:{PORT}")
    server.serve_forever()
