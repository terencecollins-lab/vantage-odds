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
  const res = await fetch('/api/markets?league=KBO&excludeStarted=false');
  const json = await res.json();
  if (!res.ok || json.success === false) {
    throw new Error(json.error || `Request failed (${res.status})`);
  }
  const seen = new Map();
  for (const item of json.items) {
    if (item.marketType !== 'Moneyline') continue;
    const key = `${item.matchup}|${item.startsAt}`;
    if (!seen.has(key)) {
      const [awayName, homeName] = item.matchup.split(' @ ');
      seen.set(key, { matchup: item.matchup, startsAt: item.startsAt, awayName, homeName });
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
