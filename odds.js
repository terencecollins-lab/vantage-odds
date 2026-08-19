// Fetches and normalizes live odds from the local /api/events proxy
// (which forwards to SportsGameOdds, keeping the API key server-side).

export const LEAGUES = [
  { id: 'NFL', label: 'NFL' },
  { id: 'NBA', label: 'NBA' },
  { id: 'MLB', label: 'MLB' },
  { id: 'NHL', label: 'NHL' },
];

export const MARKET_TYPES = ['All', 'Moneyline', 'Spread', 'Total'];

const MARKET_TYPE_BY_BETTYPE = { ml: 'Moneyline', sp: 'Spread', ou: 'Total' };

const BOOKMAKER_LABELS = {
  fanduel: 'FanDuel',
  draftkings: 'DraftKings',
  betmgm: 'BetMGM',
  caesars: 'Caesars',
  espnbet: 'ESPN BET',
  bovada: 'Bovada',
  betrivers: 'BetRivers',
  unibet: 'Unibet',
  pinnacle: 'Pinnacle',
  betonline: 'BetOnline',
  lowvig: 'LowVig',
  hardrockbet: 'Hard Rock Bet',
  betparx: 'betPARX',
  ballybet: 'Bally Bet',
  fliff: 'Fliff',
};

function bookmakerLabel(key) {
  return BOOKMAKER_LABELS[key] || key.replace(/\b\w/g, (c) => c.toUpperCase());
}

function americanToDecimal(americanStr) {
  const n = parseInt(americanStr, 10);
  if (Number.isNaN(n)) return null;
  return n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
}

export function formatAmerican(americanStr) {
  const n = parseInt(americanStr, 10);
  if (Number.isNaN(n)) return String(americanStr);
  return n > 0 ? `+${n}` : `${n}`;
}

function teamShortName(teamObj) {
  return teamObj?.names?.medium || teamObj?.names?.short || teamObj?.names?.long || 'Unknown';
}

export function buildLiveItems(events) {
  const items = [];
  for (const event of events) {
    const home = teamShortName(event.teams?.home);
    const away = teamShortName(event.teams?.away);
    const matchup = `${away} @ ${home}`;
    const startsAt = event.status?.startsAt || null;

    for (const [oddID, odd] of Object.entries(event.odds || {})) {
      if (odd.periodID !== 'game') continue; // full-game markets only for this MVP
      const marketType = MARKET_TYPE_BY_BETTYPE[odd.betTypeID];
      if (!marketType) continue; // skip even/odd, first-to-score, etc.
      if (marketType === 'Total' && odd.statEntityID !== 'all') continue; // skip team/player sub-totals here

      const bookmakerEntries = Object.entries(odd.byBookmaker || {})
        .filter(([, v]) => v.available && v.odds)
        .map(([book, v]) => ({
          book,
          label: bookmakerLabel(book),
          american: v.odds,
          decimal: americanToDecimal(v.odds),
          deeplink: v.deeplink || null,
        }))
        .filter((v) => v.decimal != null)
        .sort((a, b) => b.decimal - a.decimal);

      if (bookmakerEntries.length === 0) continue; // no per-book data at this API tier

      const best = bookmakerEntries[0];
      const fairDecimal = odd.fairOddsAvailable ? americanToDecimal(odd.fairOdds) : null;
      const edgePct = fairDecimal ? Math.round(((best.decimal - fairDecimal) / fairDecimal) * 1000) / 10 : null;

      let sideLabel;
      if (odd.betTypeID === 'ou') sideLabel = odd.sideID === 'over' ? 'Over' : 'Under';
      else sideLabel = odd.statEntityID === 'home' ? home : away;

      const line = odd.bookOverUnder ? ` ${odd.bookOverUnder}` : '';
      const name = marketType === 'Total' ? `${matchup} — Total ${sideLabel}${line}` : `${matchup} — ${marketType} (${sideLabel})`;

      items.push({
        id: `${event.eventID}-${oddID}`,
        league: event.leagueID,
        marketType,
        matchup,
        startsAt,
        name,
        bookmakers: bookmakerEntries,
        bestPrice: best.american,
        bestVendor: best.label,
        bestDeeplink: best.deeplink,
        fairOdds: odd.fairOddsAvailable ? odd.fairOdds : null,
        openBookOdds: odd.openBookOdds || null,
        edgePct,
        isOutlier: edgePct != null && edgePct >= 2,
      });
    }
  }
  return items;
}

export async function fetchLiveItems(leagueID) {
  const params = new URLSearchParams({ leagueID, oddsAvailable: 'true', limit: '12' });
  const res = await fetch(`/api/events?${params.toString()}`);
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`Bad response from server (${res.status})`);
  }
  if (!res.ok || json.success === false) {
    throw new Error(json.error || json.notice || `Request failed (${res.status})`);
  }
  return buildLiveItems(json.data || []);
}
