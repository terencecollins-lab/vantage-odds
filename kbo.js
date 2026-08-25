// Fetch client for KBO batter-vs-opponent-team matchup data. Uses the
// existing /api/markets response to discover today's games (same pattern as
// mlb.js), then /api/kbo-matchups for the actual matchup history.
//
// NOTE: matching here is by team display NAME (e.g. "Kia Tigers"), not a
// numeric id like the MLB flow uses -- there's no confirmed mapping between
// SportsGameOdds' internal KBO team ids and mykbostats.com's, so the
// backend resolves by name instead (see _resolve_kbo_team in server.py).
// If /api/kbo-matchups ever 400s with "Unrecognized KBO team name from odds
// feed", that's this assumption breaking against real data -- the fix is a
// one-line alias in server.py's KBO_TEAM_ROSTER, not a change here.

export async function fetchKboGames() {
  // excludeStarted=false: for now, KBO Matchups' own game picker should
  // still offer an already-started game (e.g. to check history mid-game),
  // even though the main Markets grid filters those out -- see
  // build_markets/handle_markets in server.py.
  //
  // This alone isn't enough to keep TODAY's already-finished KBO games
  // pickable, though: SportsGameOdds stops returning an event from this
  // oddsAvailable=true query the moment its betting market closes (usually
  // right when the game ends), so no cutoff on our end can "bring back" a
  // game that's no longer in the response at all. /api/kbo-recent-games is
  // a second, lightweight query (team names + start time only, no odds
  // required) against finalized=true events instead, which is what
  // actually surfaces those already-played games -- merged in below,
  // deduped by the same matchup+startsAt key so a game present in both
  // responses (e.g. right at the moment its market closes) doesn't double up.
  const [marketsRes, recentRes] = await Promise.all([
    fetch('/api/markets?league=KBO&excludeStarted=false'),
    fetch('/api/kbo-recent-games'),
  ]);
  const marketsJson = await marketsRes.json();
  if (!marketsRes.ok || marketsJson.success === false) {
    throw new Error(marketsJson.error || `Request failed (${marketsRes.status})`);
  }

  const seen = new Map();
  for (const item of marketsJson.items) {
    if (item.marketType !== 'Moneyline') continue;
    const key = `${item.matchup}|${item.startsAt}`;
    if (!seen.has(key)) {
      const [awayName, homeName] = item.matchup.split(' @ ');
      seen.set(key, { matchup: item.matchup, startsAt: item.startsAt, awayName, homeName });
    }
  }

  // Recent-games query failing (upstream hiccup, cold cache) shouldn't take
  // down the whole picker -- today's already-open games from the main query
  // above still work fine on their own, so this half is best-effort.
  if (recentRes.ok) {
    const recentJson = await recentRes.json();
    if (recentJson.success !== false) {
      for (const g of recentJson.games || []) {
        const key = `${g.matchup}|${g.startsAt}`;
        if (!seen.has(key)) {
          const [awayName, homeName] = g.matchup.split(' @ ');
          seen.set(key, { matchup: g.matchup, startsAt: g.startsAt, awayName, homeName });
        }
      }
    }
  }

  return [...seen.values()]
    .filter((g) => g.awayName && g.homeName)
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
}

export async function fetchKboMatchup(game) {
  const params = new URLSearchParams({ homeTeam: game.homeName, awayTeam: game.awayName });
  const res = await fetch(`/api/kbo-matchups?${params.toString()}`);
  const json = await res.json();
  if (!res.ok || json.success === false) {
    throw new Error(json.error || `Request failed (${res.status})`);
  }
  return json; // { homeBattersVsAway, awayBattersVsHome }
}
