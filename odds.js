// Thin client for the local Vantage server's /api/markets and /api/game-log
// endpoints. All SportsGameOdds parsing/normalizing happens server-side in
// server.py so the web UI and any other client share one transform.

// Grouped by sport for the league <select>'s <optgroup>s. Mirrors server.py's
// ALL_LEAGUES -- every league here fits the "Team A @ Team B" head-to-head
// card model. Golf and the SportsGameOdds NON_SPORTS categories (Politics,
// TV, Movies, etc.) are outright/prop formats with no home/away pairing, so
// they're deliberately left out.
export const LEAGUE_GROUPS = [
  { sport: 'Football', leagues: [
    { id: 'NFL', label: 'NFL' },
    { id: 'NCAAF', label: 'College Football' },
    { id: 'CFL', label: 'CFL' },
    { id: 'USFL', label: 'USFL' },
    { id: 'XFL', label: 'XFL' },
  ] },
  { sport: 'Basketball', leagues: [
    { id: 'NBA', label: 'NBA' },
    { id: 'NCAAB', label: 'College Basketball' },
    { id: 'WNBA', label: 'WNBA' },
    { id: 'NBA_G_LEAGUE', label: 'NBA G League' },
  ] },
  { sport: 'Baseball', leagues: [
    { id: 'MLB', label: 'MLB' },
    { id: 'NPB', label: 'NPB' },
    { id: 'KBO', label: 'KBO' },
    { id: 'CPBL', label: 'CPBL' },
    { id: 'MILB_AAA', label: 'MLB Minors (AAA)' },
    { id: 'WBC', label: 'WBC' },
    { id: 'LBPRC', label: 'LBPRC' },
    { id: 'LIDOM', label: 'LIDOM' },
    { id: 'LMP', label: 'LMP' },
    { id: 'LVBP', label: 'LVBP' },
  ] },
  { sport: 'Hockey', leagues: [
    { id: 'NHL', label: 'NHL' },
    { id: 'AHL', label: 'AHL' },
    { id: 'KHL', label: 'KHL' },
    { id: 'SHL', label: 'SHL' },
  ] },
  { sport: 'Soccer', leagues: [
    { id: 'EPL', label: 'Premier League' },
    { id: 'UEFA_CHAMPIONS_LEAGUE', label: 'Champions League' },
    { id: 'UEFA_EUROPA_LEAGUE', label: 'UEFA Europa League' },
    { id: 'LA_LIGA', label: 'La Liga' },
    { id: 'BUNDESLIGA', label: 'Bundesliga' },
    { id: 'IT_SERIE_A', label: 'Serie A Italy' },
    { id: 'FR_LIGUE_1', label: 'Ligue 1' },
    { id: 'MLS', label: 'MLS' },
    { id: 'BR_SERIE_A', label: 'Brasileiro Série A' },
    { id: 'LIGA_MX', label: 'Liga MX' },
    { id: 'INTERNATIONAL_SOCCER', label: 'International Soccer' },
  ] },
  { sport: 'Handball', leagues: [
    { id: 'EHF_EURO', label: 'EHF European League' },
    { id: 'EHF_EURO_CUP', label: 'EHF European Cup' },
    { id: 'SEHA', label: 'SEHA Liga' },
    { id: 'IHF_SUPER_GLOBE', label: 'IHF Super Globe' },
  ] },
  { sport: 'Tennis', leagues: [
    { id: 'ATP', label: 'ATP' },
    { id: 'WTA', label: "Women's Tennis" },
  ] },
  { sport: 'MMA', leagues: [
    { id: 'UFC', label: 'UFC' },
  ] },
];

export const LEAGUES = LEAGUE_GROUPS.flatMap((g) => g.leagues);

export const MARKET_TYPES = ['All', 'Moneyline', 'Spread', 'Total', 'Player Prop'];

export function formatAmerican(americanStr) {
  const n = parseInt(americanStr, 10);
  if (Number.isNaN(n)) return String(americanStr);
  return n > 0 ? `+${n}` : `${n}`;
}

export async function fetchMarketsRaw(leagueID) {
  const res = await fetch(`/api/markets?league=${encodeURIComponent(leagueID)}`);
  const json = await res.json();
  if (!res.ok || json.success === false) {
    throw new Error(json.error || `Request failed (${res.status})`);
  }
  return json; // { success, items, coverageSince }
}

export async function fetchLiveItems(leagueID) {
  const json = await fetchMarketsRaw(leagueID);
  return json.items;
}

export async function fetchBestNoVig() {
  const res = await fetch('/api/best-no-vig');
  const json = await res.json();
  if (!res.ok || json.success === false) {
    throw new Error(json.error || `Request failed (${res.status})`);
  }
  return json; // { items, coverageSince: {league: iso}, leagueErrors }
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
