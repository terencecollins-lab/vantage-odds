import { LEAGUES, LEAGUE_GROUPS, MARKET_TYPES, fetchLiveItems, fetchMarketsRaw, fetchBestNoVig, fetchGolf, fetchGameLog, formatAmerican } from './odds.js';
import { SAMPLE_ITEMS } from './sample-odds.js';
import { fetchMlbGames, fetchMlbMatchup } from './mlb.js';
import { fetchKboGames, fetchKboMatchup } from './kbo.js';

const WATCHLIST_KEY = 'vantage.watchlist';
const THEME_KEY = 'vantage.theme';

const state = {
  search: '',
  marketType: 'All',
  sportsbook: 'All',
  statType: 'All',
  league: LEAGUES[0].id,
  sort: 'edge',
  watchlistOnly: false,
  watchlist: new Set(JSON.parse(localStorage.getItem(WATCHLIST_KEY) || '[]')),
  items: [],
  coverageSince: {},
  usingFallback: false,
  loading: true,
  view: 'markets',
  mlbGames: [],
  mlbSelectedGameKey: null,
  mlbLoading: false,
  mlbError: null,
  mlbData: null,
  kboGames: [],
  kboSelectedGameKey: null,
  kboView: 'vsOpponent',
  kboLoading: false,
  kboError: null,
  kboData: null,
  noVigItems: [],
  noVigLoading: false,
  noVigError: null,
  noVigTimer: null,
  golfTournament: null,
  golfLeaderboard: [],
  golfHistoryTournament: null,
  golfLoading: false,
  golfError: null,
  golfTimer: null,
};

const el = {
  grid: document.getElementById('card-grid'),
  empty: document.getElementById('empty-state'),
  stats: document.getElementById('stats-row'),
  chips: document.getElementById('category-chips'),
  sort: document.getElementById('sort-select'),
  leagueSelect: document.getElementById('league-select'),
  sportsbookSelect: document.getElementById('sportsbook-select'),
  statTypeSelect: document.getElementById('stat-type-select'),
  search: document.getElementById('search-input'),
  watchlistToggle: document.getElementById('watchlist-toggle'),
  watchlistCount: document.getElementById('watchlist-count'),
  themeToggle: document.getElementById('theme-toggle'),
  modalBackdrop: document.getElementById('modal-backdrop'),
  modalContent: document.getElementById('modal-content'),
  statusBanner: document.getElementById('status-banner'),
  viewTabMarkets: document.getElementById('view-tab-markets'),
  viewTabMlb: document.getElementById('view-tab-mlb'),
  viewTabNoVig: document.getElementById('view-tab-novig'),
  viewTabGolf: document.getElementById('view-tab-golf'),
  marketsView: document.getElementById('markets-view'),
  mlbView: document.getElementById('mlb-matchups-view'),
  noVigView: document.getElementById('novig-view'),
  golfView: document.getElementById('golf-view'),
  mlbGameSelect: document.getElementById('mlb-game-select'),
  mlbMatchupContent: document.getElementById('mlb-matchup-content'),
  viewTabKbo: document.getElementById('view-tab-kbo'),
  kboView: document.getElementById('kbo-matchups-view'),
  kboGameSelect: document.getElementById('kbo-game-select'),
  kboViewSelect: document.getElementById('kbo-view-select'),
  kboMatchupContent: document.getElementById('kbo-matchup-content'),
  noVigGrid: document.getElementById('novig-grid'),
  noVigEmpty: document.getElementById('novig-empty'),
  noVigRefresh: document.getElementById('novig-refresh'),
  golfTournamentLabel: document.getElementById('golf-tournament-label'),
  golfContent: document.getElementById('golf-content'),
  golfEmpty: document.getElementById('golf-empty'),
};

function starIcon(active) {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="${active ? 'currentColor' : 'none'}">
    <path d="M12 17.3l-6.2 3.6 1.6-7-5.4-4.7 7.1-.6L12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
  </svg>`;
}

function saveWatchlist() {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify([...state.watchlist]));
}

function toggleWatchlist(id) {
  if (state.watchlist.has(id)) state.watchlist.delete(id);
  else state.watchlist.add(id);
  saveWatchlist();
  render();
}

function formatKickoff(iso) {
  if (!iso) return 'Time TBD';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Time TBD';
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function movementArrow(openAmerican, currentAmerican) {
  const open = parseInt(openAmerican, 10);
  const current = parseInt(currentAmerican, 10);
  if (Number.isNaN(open) || Number.isNaN(current) || open === current) return '';
  return current > open ? '▲' : '▼';
}

async function loadItems() {
  state.loading = true;
  render();
  try {
    const raw = await fetchMarketsRaw(state.league);
    const items = raw.items;
    state.items = items;
    state.coverageSince[state.league] = raw.coverageSince;
    state.usingFallback = false;
    if (items.length === 0) {
      showBanner(`No live markets with bookmaker odds returned for ${state.league} right now. Showing sample data instead.`);
      state.items = SAMPLE_ITEMS.filter((i) => i.league === state.league || SAMPLE_ITEMS.every((s) => s.league !== state.league));
      state.usingFallback = true;
    } else {
      hideBanner();
    }
  } catch (err) {
    console.error('Live odds fetch failed:', err);
    showBanner(`Live feed unavailable (${err.message}). Showing sample data instead.`);
    state.items = SAMPLE_ITEMS;
    state.usingFallback = true;
  }
  state.loading = false;
  render();
}

function showBanner(msg) {
  el.statusBanner.textContent = msg;
  el.statusBanner.hidden = false;
}
function hideBanner() {
  el.statusBanner.hidden = true;
}

function getAvailableSportsbooks() {
  const labels = new Set();
  state.items.forEach((item) => item.bookmakers.forEach((b) => labels.add(b.label)));
  return [...labels].sort();
}

function getAvailableStatTypes() {
  const labels = new Set();
  state.items.forEach((item) => {
    if (item.marketType === 'Player Prop' && item.statLabel) labels.add(item.statLabel);
  });
  return [...labels].sort();
}

function getFilteredItems() {
  let items = state.items.filter((item) => {
    if (state.marketType !== 'All' && item.marketType !== state.marketType) return false;
    if (state.sportsbook !== 'All' && !item.bookmakers.some((b) => b.label === state.sportsbook)) return false;
    if (state.statType !== 'All' && item.statLabel !== state.statType) return false;
    if (state.watchlistOnly && !state.watchlist.has(item.id)) return false;
    if (state.search && !item.name.toLowerCase().includes(state.search.toLowerCase())) return false;
    return true;
  });

  const sorters = {
    edge: (a, b) => (b.edgePct ?? -Infinity) - (a.edgePct ?? -Infinity),
    soonest: (a, b) => new Date(a.startsAt || 0) - new Date(b.startsAt || 0),
  };
  return items.sort(sorters[state.sort]);
}

function renderStats() {
  const outliers = state.items.filter((i) => i.isOutlier).length;
  const withEdge = state.items.filter((i) => i.edgePct != null);
  const avgEdge = withEdge.length ? Math.round((withEdge.reduce((s, i) => s + i.edgePct, 0) / withEdge.length) * 10) / 10 : 0;
  const stats = [
    { label: 'Live markets tracked', value: state.items.length },
    { label: 'Value edges found', value: outliers, positive: true },
    { label: 'Avg. edge vs. fair odds', value: `${avgEdge}%`, positive: true },
    { label: 'On your watchlist', value: state.watchlist.size },
  ];
  el.stats.innerHTML = stats
    .map(
      (s) => `<div class="stat-card">
        <div class="stat-label">${s.label}</div>
        <div class="stat-value ${s.positive ? 'positive' : ''}">${s.value}</div>
      </div>`
    )
    .join('');
}

function renderChips() {
  el.chips.innerHTML = MARKET_TYPES.map(
    (mt) => `<button class="category-chip ${mt === state.marketType ? 'active' : ''}" data-mt="${mt}">${mt}</button>`
  ).join('');
  el.chips.querySelectorAll('.category-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.marketType = btn.dataset.mt;
      render();
    });
  });
}

function renderLeagueSelect() {
  if (!el.leagueSelect.dataset.built) {
    el.leagueSelect.innerHTML = LEAGUE_GROUPS.map((g) => `<optgroup label="${g.sport}">${g.leagues.map((l) => `<option value="${l.id}">${l.label}</option>`).join('')}</optgroup>`).join('');
    el.leagueSelect.dataset.built = 'true';
    el.leagueSelect.addEventListener('change', () => {
      state.league = el.leagueSelect.value;
      loadItems();
    });
  }
  el.leagueSelect.value = state.league;
}

function renderSportsbookSelect() {
  const books = getAvailableSportsbooks();
  if (state.sportsbook !== 'All' && !books.includes(state.sportsbook)) state.sportsbook = 'All';
  const options = ['All', ...books];
  el.sportsbookSelect.innerHTML = options.map((b) => `<option value="${b}">${b === 'All' ? 'All sportsbooks' : b}</option>`).join('');
  el.sportsbookSelect.value = state.sportsbook;
  if (!el.sportsbookSelect.dataset.bound) {
    el.sportsbookSelect.dataset.bound = 'true';
    el.sportsbookSelect.addEventListener('change', () => {
      state.sportsbook = el.sportsbookSelect.value;
      renderGrid();
    });
  }
}

function renderStatTypeSelect() {
  const statTypes = getAvailableStatTypes();
  if (state.statType !== 'All' && !statTypes.includes(state.statType)) state.statType = 'All';
  const options = ['All', ...statTypes];
  el.statTypeSelect.innerHTML = options.map((s) => `<option value="${s}">${s === 'All' ? 'All stat types' : s}</option>`).join('');
  el.statTypeSelect.value = state.statType;
  if (!el.statTypeSelect.dataset.bound) {
    el.statTypeSelect.dataset.bound = 'true';
    el.statTypeSelect.addEventListener('change', () => {
      state.statType = el.statTypeSelect.value;
      renderGrid();
    });
  }
}

function formatCoverageSince(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function renderCard(item) {
  const isWatched = state.watchlist.has(item.id);
  const arrow = movementArrow(item.openBookOdds, item.bestPrice);
  const coverageLabel = item.statID ? formatCoverageSince(state.coverageSince[item.league]) : null;
  return `<article class="item-card" data-id="${item.id}">
    <button class="star-btn ${isWatched ? 'active' : ''}" data-star="${item.id}" title="Toggle watchlist">${starIcon(isWatched)}</button>
    <div class="card-top">
      <span class="card-category">${item.league} · ${item.marketType}</span>
      ${item.isOutlier ? '<span class="outlier-badge">Value edge</span>' : ''}
    </div>
    <div class="item-name">${item.name}</div>
    <div class="rating-row">${formatKickoff(item.startsAt)} ${coverageLabel ? `<span class="coverage-badge" title="Earliest finalized-game history SportsGameOdds has for ${item.league} — used for the recent-form stats below">History since ${coverageLabel}</span>` : ''}</div>
    <div class="movement-row">${item.openBookOdds ? `Opened ${formatAmerican(item.openBookOdds)} → Now ${formatAmerican(item.bestPrice)} ${arrow}` : ''}</div>
    <div class="price-row">
      <span class="best-price">${formatAmerican(item.bestPrice)}</span>
      ${item.fairOdds ? `<span class="market-price">${formatAmerican(item.fairOdds)}</span>` : ''}
      ${item.edgePct != null ? `<span class="savings-pct">${item.edgePct >= 0 ? '+' : ''}${item.edgePct}%</span>` : ''}
    </div>
    <div class="vendor-row"><span>Best at</span><span class="vendor-name">${item.bestVendor}</span></div>
    ${item.noVigProb != null ? `<div class="vendor-row"><span>No-vig</span><span>${item.noVigProb}%</span></div>` : ''}
  </article>`;
}

function bindCardEvents(container) {
  container.querySelectorAll('.star-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWatchlist(btn.dataset.star);
    });
  });
  container.querySelectorAll('.item-card').forEach((card) => {
    card.addEventListener('click', () => openModal(card.dataset.id));
  });
}

function renderGrid() {
  const items = getFilteredItems();
  el.empty.hidden = items.length !== 0 || state.loading;
  el.grid.innerHTML = state.loading ? '<p class="empty-state">Loading live odds…</p>' : items.map(renderCard).join('');
  bindCardEvents(el.grid);
}

function openModal(id) {
  const item = state.items.find((i) => i.id === id) || state.noVigItems.find((i) => i.id === id);
  if (!item) return;
  const isWatched = state.watchlist.has(item.id);
  const hasAnyLine = item.bookmakers.some((b) => b.line != null);
  const rows = item.bookmakers
    .map((b) => {
      const isBest = b.onLine !== false && b.label === item.bestVendor && b.american === item.bestPrice;
      const lineCell = hasAnyLine
        ? `<td class="${b.onLine === false ? 'offline-line' : ''}" title="${b.onLine === false ? 'Different line than the consensus — not directly comparable' : ''}">${b.line ?? ''}</td>`
        : '';
      return `<tr class="${isBest ? 'best-row' : ''} ${b.onLine === false ? 'offline-row' : ''}">
        <td class="vendor-name">${b.label}</td>
        ${lineCell}
        <td class="price-cell">${formatAmerican(b.american)}</td>
        <td>${b.deeplink ? `<a class="stock-tag in" href="${b.deeplink}" target="_blank" rel="noopener">Open ↗</a>` : '<span class="stock-tag out">No link</span>'}</td>
      </tr>`;
    })
    .join('');

  el.modalContent.innerHTML = `
    <button class="modal-close" id="modal-close">&times;</button>
    <span class="card-category">${item.league} · ${item.marketType}</span>
    <h2>${item.name}</h2>
    <div class="rating-row">${formatKickoff(item.startsAt)}</div>
    <div class="price-row">
      <span class="best-price">${formatAmerican(item.bestPrice)}</span>
      ${item.fairOdds ? `<span class="market-price">${formatAmerican(item.fairOdds)} fair</span>` : ''}
      ${item.edgePct != null ? `<span class="savings-pct">${item.edgePct >= 0 ? '+' : ''}${item.edgePct}% vs. fair odds</span>` : ''}
    </div>
    ${item.noVigProb != null ? `<div class="novig-row">No-vig probability: <strong>${item.noVigProb}%</strong> <span class="form-note">(devigged from this line's two-sided odds)</span></div>` : ''}
    ${
      item.bookmakers.length
        ? `<table class="vendor-table">
      <thead><tr><th>Sportsbook</th>${hasAnyLine ? '<th>Line</th>' : ''}<th>Odds</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${item.bookmakers.some((b) => b.onLine === false) ? '<p class="form-note">Rows in a different shade quote a different line than the rest — their price isn\'t directly comparable and isn\'t eligible to be "best price."</p>' : ''}`
        : '<p class="form-note">No sportsbook currently quotes this exact line — showing the consensus price only.</p>'
    }
    ${item.statID ? '<div id="recent-form" class="recent-form"><h3>Recent form</h3><p class="form-note">Loading…</p></div>' : ''}
    <div class="modal-actions">
      <button class="btn-secondary" id="modal-star">${isWatched ? '★ Remove from watchlist' : '☆ Add to watchlist'}</button>
      <button class="btn-primary" id="modal-close-2">Close</button>
    </div>
  `;
  el.modalBackdrop.hidden = false;
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-close-2').addEventListener('click', closeModal);
  document.getElementById('modal-star').addEventListener('click', () => {
    toggleWatchlist(item.id);
    openModal(item.id);
  });
  if (item.statID) renderRecentForm(item);
}

// Unified hit test: player props and game totals compare a stat value
// against a line; team_win/team_margin have their own pass/fail shape.
function isHit(item, statValue) {
  if (item.statID === 'team_win') return statValue > 0.5;
  const line = item.line == null ? null : Number(item.line);
  if (item.statID === 'team_margin') {
    if (line == null) return null;
    const margin = statValue + line;
    return margin === 0 ? null : margin > 0;
  }
  if (line == null) return null;
  return item.side === 'under' ? statValue < line : statValue > line;
}

function formGuideDots(games, item, cap = 20) {
  if (!games.length) return '<span class="form-empty">No recent games found</span>';
  const dots = games
    .slice(0, cap)
    .map((g) => {
      const hit = isHit(item, g.statValue);
      const cls = hit == null ? '' : hit ? 'hit' : 'miss';
      const title = `vs ${g.opponentName}: ${g.statValue}`;
      return `<span class="form-dot ${cls}" title="${title}"></span>`;
    })
    .join('');
  const more = games.length > cap ? `<span class="form-more">+${games.length - cap} more</span>` : '';
  return dots + more;
}

function hitRateLabel(games, item) {
  if (!games.length) return '—';
  const hits = games.filter((g) => isHit(item, g.statValue)).length;
  return `${hits}/${games.length}`;
}

function recentFormCaption(item) {
  if (item.statID === 'team_win') return 'Dots show most recent first. Green = won that game.';
  if (item.statID === 'team_margin') return `Dots show most recent first. Green = covered this spread (${item.line ?? ''}).`;
  const sideWord = item.side === 'under' ? 'under' : 'over';
  return `Dots show most recent first. Green = would have hit ${sideWord} ${item.line ?? ''}.`;
}

function coverageNote(coverage, gamesPlayed, item) {
  if (!coverage?.earliestAvailable) return 'No historical events were returned to scan.';
  const earliest = new Date(coverage.earliestAvailable);
  const years = (Date.now() - earliest.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
  const dateLabel = earliest.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  const seasonCaveat = years < 4.5 ? ` SportsGameOdds' data for this league only goes back this far — a full 5 seasons isn't available.` : '';
  const subject = item.playerID ? 'played by this player' : 'played by this team';
  return `Scanned all ${coverage.eventsScanned} finalized games back to ${dateLabel} (${gamesPlayed} ${subject}).${seasonCaveat}`;
}

async function renderRecentForm(item) {
  const container = document.getElementById('recent-form');
  if (!container) return;
  try {
    const { games, h2h, coverage } = await fetchGameLog({
      league: item.league,
      teamID: item.playerTeamID,
      playerID: item.playerID,
      statID: item.statID,
      opponentTeamID: item.opponentTeamID,
    });
    const last5 = games.slice(0, 5);
    const last10 = games.slice(0, 10);
    const last5H2H = h2h.slice(0, 5);
    container.innerHTML = `
      <h3>Recent form</h3>
      <div class="form-row"><span class="form-label">Last 5</span><span class="form-dots">${formGuideDots(last5, item)}</span><span class="form-rate">${hitRateLabel(last5, item)}</span></div>
      <div class="form-row"><span class="form-label">Last 10</span><span class="form-dots">${formGuideDots(last10, item)}</span><span class="form-rate">${hitRateLabel(last10, item)}</span></div>
      <div class="form-row"><span class="form-label">All seasons</span><span class="form-dots">${formGuideDots(games, item)}</span><span class="form-rate">${hitRateLabel(games, item)}</span></div>
      <div class="form-row"><span class="form-label">Last 5 H2H</span><span class="form-dots">${formGuideDots(last5H2H, item)}</span><span class="form-rate">${hitRateLabel(last5H2H, item)}</span></div>
      <div class="form-row"><span class="form-label">All-time H2H</span><span class="form-dots">${formGuideDots(h2h, item)}</span><span class="form-rate">${hitRateLabel(h2h, item)}</span></div>
      <p class="form-note">${recentFormCaption(item)}</p>
      <p class="form-note">${coverageNote(coverage, games.length, item)}</p>
    `;
  } catch (err) {
    container.innerHTML = `<p class="form-note">Recent form unavailable (${err.message}).</p>`;
  }
}

function closeModal() {
  el.modalBackdrop.hidden = true;
  el.modalContent.innerHTML = '';
}

function render() {
  renderStats();
  renderChips();
  renderLeagueSelect();
  renderSportsbookSelect();
  renderStatTypeSelect();
  renderGrid();
  el.watchlistCount.textContent = state.watchlist.size;
  el.watchlistToggle.classList.toggle('active', state.watchlistOnly);
}

el.search.addEventListener('input', (e) => {
  state.search = e.target.value;
  renderGrid();
});
el.sort.addEventListener('change', (e) => {
  state.sort = e.target.value;
  renderGrid();
});
el.watchlistToggle.addEventListener('click', () => {
  state.watchlistOnly = !state.watchlistOnly;
  render();
});
el.modalBackdrop.addEventListener('click', (e) => {
  if (e.target === el.modalBackdrop) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);
}
el.themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
});
applyTheme(localStorage.getItem(THEME_KEY) || 'light');

function gameKey(game) {
  return `${game.matchup}|${game.startsAt}`;
}

function formatGameLabel(game) {
  const d = new Date(game.startsAt);
  const dateLabel = d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `${game.matchup} — ${dateLabel}`;
}

async function loadMlbGames() {
  el.mlbGameSelect.innerHTML = '<option>Loading games…</option>';
  try {
    state.mlbGames = await fetchMlbGames();
    if (state.mlbGames.length === 0) {
      el.mlbGameSelect.innerHTML = '<option>No upcoming MLB games found</option>';
      el.mlbMatchupContent.innerHTML = '';
      return;
    }
    el.mlbGameSelect.innerHTML = state.mlbGames.map((g) => `<option value="${gameKey(g)}">${formatGameLabel(g)}</option>`).join('');
    state.mlbSelectedGameKey = gameKey(state.mlbGames[0]);
    el.mlbGameSelect.value = state.mlbSelectedGameKey;
    await loadMlbMatchup();
  } catch (err) {
    el.mlbGameSelect.innerHTML = '<option>Error loading games</option>';
    el.mlbMatchupContent.innerHTML = `<p class="form-note">Could not load MLB games (${err.message}).</p>`;
  }
}

function hitterRow(b) {
  const s = b.stats;
  const fmt = (v) => (v != null ? v.toFixed(3).replace(/^0/, '') : '—');
  return `<tr>
    <td>${b.fullName}</td>
    <td>${b.position}</td>
    <td>${s.plateAppearances}</td>
    <td>${s.atBats}</td>
    <td>${s.hits}</td>
    <td>${s.homeRuns}</td>
    <td>${s.walks}</td>
    <td>${s.strikeouts}</td>
    <td>${fmt(s.avg)}</td>
    <td>${fmt(s.obp)}</td>
    <td>${fmt(s.slg)}</td>
    <td>${fmt(s.ops)}</td>
  </tr>`;
}

function pitcherCard(title, sideData) {
  if (!sideData) {
    return `<div class="mlb-pitcher-card"><h3>${title}</h3><p class="mlb-subtitle">Probable pitcher not yet announced.</p></div>`;
  }
  if (sideData.batters.length === 0) {
    return `<div class="mlb-pitcher-card"><h3>${sideData.pitcher.fullName}</h3><p class="mlb-subtitle">No career at-bats found against this lineup.</p></div>`;
  }
  return `<div class="mlb-pitcher-card">
    <h3>${sideData.pitcher.fullName}</h3>
    <p class="mlb-subtitle">${title}</p>
    <div class="mlb-table-wrap">
      <table class="mlb-table">
        <thead><tr><th>Batter</th><th>Pos</th><th>PA</th><th>AB</th><th>H</th><th>HR</th><th>BB</th><th>K</th><th>AVG</th><th>OBP</th><th>SLG</th><th>OPS</th></tr></thead>
        <tbody>${sideData.batters.map(hitterRow).join('')}</tbody>
      </table>
    </div>
  </div>`;
}

async function loadMlbMatchup() {
  const game = state.mlbGames.find((g) => gameKey(g) === state.mlbSelectedGameKey);
  if (!game) return;
  el.mlbMatchupContent.innerHTML = '<p class="form-note">Loading matchup data…</p>';
  try {
    const [awayName, homeName] = game.matchup.split(' @ ');
    const data = await fetchMlbMatchup(game);
    state.mlbData = data;
    el.mlbMatchupContent.innerHTML =
      pitcherCard(`vs. ${awayName} hitters`, data.homePitcherVsAwayHitters) +
      pitcherCard(`vs. ${homeName} hitters`, data.awayPitcherVsHomeHitters);
  } catch (err) {
    el.mlbMatchupContent.innerHTML = `<p class="form-note">Could not load matchup data (${err.message}).</p>`;
  }
}

async function loadKboGames() {
  el.kboGameSelect.innerHTML = '<option>Loading games…</option>';
  try {
    state.kboGames = await fetchKboGames();
    if (state.kboGames.length === 0) {
      el.kboGameSelect.innerHTML = '<option>No upcoming KBO games found</option>';
      el.kboMatchupContent.innerHTML = '';
      return;
    }
    el.kboGameSelect.innerHTML = state.kboGames.map((g) => `<option value="${gameKey(g)}">${formatGameLabel(g)}</option>`).join('');
    state.kboSelectedGameKey = gameKey(state.kboGames[0]);
    el.kboGameSelect.value = state.kboSelectedGameKey;
    await loadKboMatchup();
  } catch (err) {
    el.kboGameSelect.innerHTML = '<option>Error loading games</option>';
    el.kboMatchupContent.innerHTML = `<p class="form-note">Could not load KBO games (${err.message}).</p>`;
  }
}

function kboBatterRow(b) {
  const s = b.stats[state.kboView];
  const fmt = (v) => (v != null ? v.toFixed(3).replace(/^0/, '') : '—');
  if (!s) {
    return `<tr class="kbo-row-empty"><td>${b.fullName}</td><td colspan="7">No games in this window</td></tr>`;
  }
  return `<tr>
    <td>${b.fullName}</td>
    <td>${s.gamesFound}</td>
    <td>${s.atBats}</td>
    <td>${s.hits}</td>
    <td>${s.runs}</td>
    <td>${s.rbi}</td>
    <td>${s.homeRuns}</td>
    <td>${fmt(s.avg)}</td>
  </tr>`;
}

function kboTeamCard(title, batters) {
  if (!batters || batters.length === 0) {
    return `<div class="mlb-pitcher-card"><h3>${title}</h3><p class="mlb-subtitle">No data found for this view.</p></div>`;
  }
  return `<div class="mlb-pitcher-card">
    <h3>${title}</h3>
    <div class="mlb-table-wrap">
      <table class="mlb-table">
        <thead><tr><th>Batter</th><th>GP</th><th>AB</th><th>H</th><th>R</th><th>RBI</th><th>HR</th><th>AVG</th></tr></thead>
        <tbody>${batters.map(kboBatterRow).join('')}</tbody>
      </table>
    </div>
  </div>`;
}

function renderKboMatchup() {
  const data = state.kboData;
  const game = state.kboGames.find((g) => gameKey(g) === state.kboSelectedGameKey);
  if (!data || !game) return;
  // Prefer the backend's resolved full team names (e.g. "Kia Tigers") over
  // game.awayName/homeName, which come straight from the odds feed and can
  // be an abbreviation (e.g. "TIG") -- see _resolve_kbo_team in server.py.
  const awayLabel = data.awayTeamName || game.awayName;
  const homeLabel = data.homeTeamName || game.homeName;
  el.kboMatchupContent.innerHTML =
    kboTeamCard(`${awayLabel} batters vs. ${homeLabel}`, data.awayBattersVsHome) +
    kboTeamCard(`${homeLabel} batters vs. ${awayLabel}`, data.homeBattersVsAway);
}

async function loadKboMatchup() {
  const game = state.kboGames.find((g) => gameKey(g) === state.kboSelectedGameKey);
  if (!game) return;
  el.kboMatchupContent.innerHTML = '<p class="form-note">Loading matchup data… (mykbostats.com is slower than MLB\'s API, this can take a few seconds)</p>';
  try {
    state.kboData = await fetchKboMatchup(game);
    renderKboMatchup();
  } catch (err) {
    el.kboMatchupContent.innerHTML = `<p class="form-note">Could not load matchup data (${err.message}).</p>`;
  }
}

const NOVIG_REFRESH_INTERVAL_MS = 30000;

async function loadBestNoVig() {
  state.noVigLoading = true;
  state.noVigError = null;
  renderNoVig();
  try {
    const { items, coverageSince } = await fetchBestNoVig();
    state.noVigItems = items;
    Object.assign(state.coverageSince, coverageSince || {});
  } catch (err) {
    state.noVigError = err.message;
  }
  state.noVigLoading = false;
  renderNoVig();
}

function renderNoVig() {
  if (state.noVigLoading && state.noVigItems.length === 0) {
    el.noVigEmpty.hidden = true;
    el.noVigGrid.innerHTML = '<p class="empty-state">Scanning all sports for the best no-vig edges…</p>';
    return;
  }
  if (state.noVigError && state.noVigItems.length === 0) {
    el.noVigEmpty.hidden = true;
    el.noVigGrid.innerHTML = `<p class="empty-state">Could not load cross-sport edges (${state.noVigError}).</p>`;
    return;
  }
  el.noVigEmpty.hidden = state.noVigItems.length !== 0;
  el.noVigGrid.innerHTML = state.noVigItems.map(renderCard).join('');
  bindCardEvents(el.noVigGrid);
}

function startNoVigAutoRefresh() {
  stopNoVigAutoRefresh();
  state.noVigTimer = setInterval(loadBestNoVig, NOVIG_REFRESH_INTERVAL_MS);
}

function stopNoVigAutoRefresh() {
  if (state.noVigTimer) {
    clearInterval(state.noVigTimer);
    state.noVigTimer = null;
  }
}

const GOLF_REFRESH_INTERVAL_MS = 60000;

function golfRoundCell(round) {
  const cls = round.underPar ? 'golf-round-score under-par' : 'golf-round-score';
  return `<span class="${cls}" title="Round ${round.round}: ${round.strokes} (par ${round.par})">${round.strokes}</span>`;
}

function renderGolfRow(player, rank) {
  const histBadge = player.historicalUnderPar
    ? `<span class="golf-hist-badge" title="Also went under par at this event in ${player.historicalYear} (best round: ${player.historicalBestRound})">Under par here in ${player.historicalYear}</span>`
    : '';
  return `<div class="golf-row">
    <span class="golf-rank">${rank}</span>
    <span class="golf-name">${player.name}</span>
    <span class="golf-total">${player.total ?? '—'}</span>
    <div class="golf-rounds">${player.rounds.map(golfRoundCell).join('')}</div>
    ${histBadge}
  </div>`;
}

function renderGolf() {
  if (state.golfLoading && !state.golfTournament) {
    el.golfEmpty.hidden = true;
    el.golfTournamentLabel.textContent = 'Loading current PGA Tour event…';
    el.golfContent.innerHTML = '';
    return;
  }
  if (state.golfError && !state.golfTournament) {
    el.golfEmpty.hidden = true;
    el.golfTournamentLabel.textContent = `Could not load golf leaderboard (${state.golfError}).`;
    el.golfContent.innerHTML = '';
    return;
  }
  if (!state.golfTournament) {
    el.golfTournamentLabel.textContent = 'No PGA Tour event is currently in progress.';
    el.golfEmpty.hidden = false;
    el.golfContent.innerHTML = '';
    return;
  }
  el.golfEmpty.hidden = true;
  const historyNote = state.golfHistoryTournament
    ? ` — cross-referenced against 2021–2025 under-par history for ${state.golfHistoryTournament}`
    : ' (no under-par history tracked for this event)';
  el.golfTournamentLabel.textContent = `${state.golfTournament.name} — ${state.golfTournament.status}${historyNote}`;
  const sorted = [...state.golfLeaderboard].sort((a, b) => {
    const av = a.total === 'E' ? 0 : parseInt(a.total, 10);
    const bv = b.total === 'E' ? 0 : parseInt(b.total, 10);
    return (Number.isNaN(av) ? 999 : av) - (Number.isNaN(bv) ? 999 : bv);
  });
  el.golfContent.innerHTML = `<div class="mlb-pitcher-card">${sorted.map((p, i) => renderGolfRow(p, i + 1)).join('')}</div>`;
}

async function loadGolf() {
  state.golfLoading = true;
  state.golfError = null;
  renderGolf();
  try {
    const { tournament, leaderboard, historyTournament } = await fetchGolf();
    state.golfTournament = tournament;
    state.golfLeaderboard = leaderboard || [];
    state.golfHistoryTournament = historyTournament;
  } catch (err) {
    state.golfError = err.message;
  }
  state.golfLoading = false;
  renderGolf();
}

function startGolfAutoRefresh() {
  stopGolfAutoRefresh();
  state.golfTimer = setInterval(loadGolf, GOLF_REFRESH_INTERVAL_MS);
}

function stopGolfAutoRefresh() {
  if (state.golfTimer) {
    clearInterval(state.golfTimer);
    state.golfTimer = null;
  }
}

function setView(view) {
  state.view = view;
  el.viewTabMarkets.classList.toggle('active', view === 'markets');
  el.viewTabMlb.classList.toggle('active', view === 'mlb');
  el.viewTabKbo.classList.toggle('active', view === 'kbo');
  el.viewTabNoVig.classList.toggle('active', view === 'novig');
  el.viewTabGolf.classList.toggle('active', view === 'golf');
  el.marketsView.hidden = view !== 'markets';
  el.mlbView.hidden = view !== 'mlb';
  el.kboView.hidden = view !== 'kbo';
  el.noVigView.hidden = view !== 'novig';
  el.golfView.hidden = view !== 'golf';
  if (view === 'mlb' && state.mlbGames.length === 0) {
    loadMlbGames();
  }
  if (view === 'kbo' && state.kboGames.length === 0) {
    loadKboGames();
  }
  if (view === 'novig') {
    if (state.noVigItems.length === 0) loadBestNoVig();
    startNoVigAutoRefresh();
  } else {
    stopNoVigAutoRefresh();
  }
  if (view === 'golf') {
    if (!state.golfTournament) loadGolf();
    startGolfAutoRefresh();
  } else {
    stopGolfAutoRefresh();
  }
}

el.viewTabMarkets.addEventListener('click', () => setView('markets'));
el.viewTabMlb.addEventListener('click', () => setView('mlb'));
el.viewTabGolf.addEventListener('click', () => setView('golf'));
el.viewTabNoVig.addEventListener('click', () => setView('novig'));
el.noVigRefresh.addEventListener('click', () => loadBestNoVig());
el.mlbGameSelect.addEventListener('change', () => {
  state.mlbSelectedGameKey = el.mlbGameSelect.value;
  loadMlbMatchup();
});
el.viewTabKbo.addEventListener('click', () => setView('kbo'));
el.kboGameSelect.addEventListener('change', () => {
  state.kboSelectedGameKey = el.kboGameSelect.value;
  loadKboMatchup();
});
el.kboViewSelect.addEventListener('change', () => {
  state.kboView = el.kboViewSelect.value;
  renderKboMatchup();
});

render();
loadItems();
