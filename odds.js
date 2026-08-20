// Thin client for the local Vantage server's /api/markets and /api/game-log
// endpoints. All SportsGameOdds parsing/normalizing happens server-side in
// server.py so the web UI and any other client share one transform.

export const LEAGUES = [
  { id: 'NFL', label: 'NFL' },
  { id: 'NBA', label: 'NBA' },
  { id: 'MLB', label: 'MLB' },
  { id: 'NHL', label: 'NHL' },
];

export const MARKET_TYPES = ['All', 'Moneyline', 'Spread', 'Total', 'Player Prop'];

export function formatAmerican(americanStr) {
  const n = parseInt(americanStr, 10);
  if (Number.isNaN(n)) return String(americanStr);
  return n > 0 ? `+${n}` : `${n}`;
}

export async function fetchLiveItems(leagueID) {
  const res = await fetch(`/api/markets?league=${encodeURIComponent(leagueID)}`);
  const json = await res.json();
  if (!res.ok || json.success === false) {
    throw new Error(json.error || `Request failed (${res.status})`);
  }
  return json.items;
}

export async function fetchGameLog({ league, teamID, playerID, statID, opponentTeamID }) {
  const params = new URLSearchParams({ league, teamID, statID });
  if (playerID) params.set('playerID', playerID);
  if (opponentTeamID) params.set('opponentTeamID', opponentTeamID);
  const res = await fetch(`/api/game-log?${params.toString()}`);
  const json = await res.json();
  if (!res.ok || json.success === false) {
    throw new Error(json.error || `Request failed (${res.status})`);
  }
  return json; // { games: [...all available, desc...], h2h: [...], coverage: {...} }
}
