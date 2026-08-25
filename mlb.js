// Fetch client for MLB batter-vs-pitcher matchup data. Uses the existing
// /api/markets response to discover upcoming games (no new discovery
// endpoint needed), then /api/mlb-matchups for the actual matchup history.

export async function fetchMlbGames() {
  // excludeStarted=false: for now, MLB Matchups' own game picker should
  // still offer an already-started game (e.g. to check history mid-game),
  // even though the main Markets grid filters those out -- see
  // build_markets/handle_markets in server.py.
  const res = await fetch('/api/markets?league=MLB&excludeStarted=false');
  const json = await res.json();
  if (!res.ok || json.success === false) {
    throw new Error(json.error || `Request failed (${res.status})`);
  }
  const seen = new Map();
  for (const item of json.items) {
    if (item.marketType !== 'Moneyline') continue;
    const key = `${item.matchup}|${item.startsAt}`;
    if (!seen.has(key)) {
      seen.set(key, { matchup: item.matchup, startsAt: item.startsAt, homeTeamID: null, awayTeamID: null });
    }
    const entry = seen.get(key);
    if (item.side === 'home') entry.homeTeamID = item.playerTeamID;
    if (item.side === 'away') entry.awayTeamID = item.playerTeamID;
  }
  return [...seen.values()]
    .filter((g) => g.homeTeamID && g.awayTeamID)
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
}

export async function fetchMlbMatchup(game) {
  const gameDate = game.startsAt.slice(0, 10);
  const params = new URLSearchParams({
    homeTeamID: game.homeTeamID,
    awayTeamID: game.awayTeamID,
    gameDate,
  });
  const res = await fetch(`/api/mlb-matchups?${params.toString()}`);
  const json = await res.json();
  if (!res.ok || json.success === false) {
    throw new Error(json.error || `Request failed (${res.status})`);
  }
  return json; // { homePitcherVsAwayHitters, awayPitcherVsHomeHitters }
}

// Fetched once per batter, lazily, when their player card is opened -- not
// eagerly for a whole lineup up front. Covers every view tab the player card
// modal offers except Last 5/10/20 (those are the same 'games' array sliced
// client-side to different lengths, not three separate requests).
export async function fetchMlbPlayerSplits({ batterID, pitcherID, opponentTeamID }) {
  const params = new URLSearchParams({ batterID });
  if (pitcherID) params.set('pitcherID', pitcherID);
  if (opponentTeamID) params.set('opponentTeamID', opponentTeamID);
  const res = await fetch(`/api/mlb-player-splits?${params.toString()}`);
  const json = await res.json();
  if (!res.ok || json.success === false) {
    throw new Error(json.error || `Request failed (${res.status})`);
  }
  return json; // { vsTeam, vsPitcher, games, seasons: [{year, stats}, ...] }
}
