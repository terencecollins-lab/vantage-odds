import { LEAGUES, LEAGUE_GROUPS, MARKET_TYPES, fetchLiveItems, fetchMarketsRaw, fetchBestNoVig, fetchGolf, fetchGameLog, formatAmerican } from './odds.js';
import { SAMPLE_ITEMS } from './sample-odds.js';
import { fetchMlbGames, fetchMlbMatchup, fetchMlbPlayerSplits } from './mlb.js';
import { fetchKboGames, fetchKboMatchup } from './kbo.js';

const WATCHLIST_KEY = 'vantage.watchlist';
const THEME_KEY = 'vantage.theme';

const state = {
  search: '',
  marketType: 'All',
  sportsbook: 'PrizePicks',
  statType: 'All',
  league: 'MLB',
  sort: 'edge',
  watchlistOnly: false,
  watchlist: new Set(JSON.parse(localStorage.getItem(WATCHLIST_KEY) || '[]')),
  items: [],
  coverageSince: {},
  usingFallback: false,
  loading: true,
  view: 'markets',
  mlbGames: [],
  mlbSelectedDate: null,
  mlbSelectedGameKey: null,
  mlbLoading: false,
  mlbError: null,
  mlbData: null,
  kboGames: [],
  kboSelectedDate: null,
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
  hitRateFilter: null, // {window, from, to} once applied via the panel's "Show N Results" button
  hitRateWindow: 'l5',
  hitRateFrom: 0,
  hitRateTo: 100,
  hitRateStarted: false, // true once the user explicitly clicks "Load Hit Rates" -- opening the panel no longer eagerly fetches on its own
  hitRateLoading: false,
  hitRateLoadedCount: 0,
  hitRateTotalCount: 0,
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
  mlbDateSelect: document.getElementById('mlb-date-select'),
  mlbMatchupContent: document.getElementById('mlb-matchup-content'),
  viewTabKbo: document.getElementById('view-tab-kbo'),
  kboView: document.getElementById('kbo-matchups-view'),
  kboGameSelect: document.getElementById('kbo-game-select'),
  kboDateSelect: document.getElementById('kbo-date-select'),
  kboViewSelect: document.getElementById('kbo-view-select'),
  kboMatchupContent: document.getElementById('kbo-matchup-content'),
  noVigGrid: document.getElementById('novig-grid'),
  noVigEmpty: document.getElementById('novig-empty'),
  noVigRefresh: document.getElementById('novig-refresh'),
  golfTournamentLabel: document.getElementById('golf-tournament-label'),
  golfContent: document.getElementById('golf-content'),
  golfEmpty: document.getElementById('golf-empty'),
  hitRateFilterBtn: document.getElementById('hit-rate-filter-btn'),
  hitRateBadge: document.getElementById('hit-rate-badge'),
};

function starIcon(active) {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="${active ? 'currentColor' : 'none'}">
    <path d="M12 17.3l-6.2 3.6 1.6-7-5.4-4.7 7.1-.6L12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
  </svg>`;
}

// Compact loading icon: the same V-gradient + light-sweep shimmer as the
// full-screen splash (see index.html/style.css's .app-splash), just scaled
// down for inline use inside cards/modals/tab content. Each call gets its
// own gradient/clipPath id (a random suffix) so multiple loading spots
// rendering at once -- e.g. the grid and a modal both mid-fetch -- never
// collide on a duplicate SVG id.
let loadingVIdCounter = 0;
function loadingVSvg() {
  const id = `loadingV${loadingVIdCounter++}`;
  return `<svg class="loading-v" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#8b7bff"/>
        <stop offset="100%" stop-color="#35c99a"/>
      </linearGradient>
      <clipPath id="${id}-clip">
        <path d="M14 10 L50 82 L86 10 L70 10 L50 54 L30 10 Z"/>
      </clipPath>
    </defs>
    <path class="loading-v-trace" stroke="url(#${id})" d="M14 10 L50 82 L86 10"/>
    <path class="loading-v-fill" fill="url(#${id})" d="M14 10 L50 82 L86 10 L70 10 L50 54 L30 10 Z"/>
    <g clip-path="url(#${id}-clip)">
      <rect class="loading-v-shimmer" x="-20" y="-20" width="35" height="140" fill="rgba(255,255,255,0.6)"/>
    </g>
  </svg>`;
}

// Shared "stats are loading" overlay: the V icon plus a status message
// underneath it, dropped in wherever a matchup/splits/odds fetch is in
// flight (see loadMlbMatchup, loadKboMatchup, openMlbPlayerModal,
// renderGrid, renderNoVig). Centered block, not a fixed-position overlay
// over the whole page -- it replaces the loading area's own content the
// same way the plain "Loading…" text it's superseding did, just with the
// icon.
function loadingOverlay(message) {
  return `<div class="loading-overlay">${loadingVSvg()}<p class="loading-overlay-text">${message}</p></div>`;
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

// Player-prop and Total market names already end in "{market label}
// {Over|Under} {line}" (see build_markets in server.py), and the market
// label itself sometimes already contains the word "Over/Under" (e.g. a
// prop literally named "Total Bases Over/Under") -- so the actual
// selection can visually disappear right after an near-identical-looking
// word. This splits the trailing "{Over|Under} {line}" back off (rebuilt
// from item.side/item.line, the same fields the name was built from) so it
// can be rendered as its own distinct badge instead of blending into the
// rest of the name.
function splitPropSideSuffix(item) {
  if (item.line == null || (item.side !== 'over' && item.side !== 'under')) return null;
  const sideLabel = item.side === 'under' ? 'Under' : 'Over';
  const suffix = ` ${sideLabel} ${item.line}`;
  if (!item.name.endsWith(suffix)) return null;
  return { base: item.name.slice(0, -suffix.length), sideLabel, line: item.line };
}

function formatItemNameHtml(item) {
  const split = splitPropSideSuffix(item);
  if (!split) return item.name;
  const sideClass = split.sideLabel === 'Under' ? 'side-under' : 'side-over';
  return `${split.base} <span class="prop-side-badge ${sideClass}">${split.sideLabel} ${split.line}</span>`;
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

function getFilteredItems({ ignoreHitRate = false } = {}) {
  let items = state.items.filter((item) => {
    if (state.marketType !== 'All' && item.marketType !== state.marketType) return false;
    if (state.sportsbook !== 'All' && !item.bookmakers.some((b) => b.label === state.sportsbook)) return false;
    if (state.statType !== 'All' && item.statLabel !== state.statType) return false;
    if (state.watchlistOnly && !state.watchlist.has(item.id)) return false;
    if (state.search && !item.name.toLowerCase().includes(state.search.toLowerCase())) return false;
    if (!ignoreHitRate && state.hitRateFilter) {
      if (!item.statID) return false;
      const cached = miniFormCache.get(item.id);
      if (!cached || cached === 'error') return false;
      const hr = computeHitRateForWindow(item, cached, state.hitRateFilter.window);
      if (hr == null || hr < state.hitRateFilter.from || hr > state.hitRateFilter.to) return false;
    }
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
    <div class="item-name">${formatItemNameHtml(item)}</div>
    <div class="rating-row">${formatKickoff(item.startsAt)} ${coverageLabel ? `<span class="coverage-badge" title="Earliest finalized-game history SportsGameOdds has for ${item.league} — used for the recent-form stats below">History since ${coverageLabel}</span>` : ''}</div>
    <div class="movement-row">${item.openBookOdds ? `Opened ${formatAmerican(item.openBookOdds)} → Now ${formatAmerican(item.bestPrice)} ${arrow}` : ''}</div>
    ${item.statID ? `<div class="mini-form-slot mini-form-loading" data-mini="${item.id}">Loading recent form…</div>` : ''}
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

// Mini recent-form strip on each card: last 5 games + last 5 H2H, using the
// exact same hit/miss dot language as the modal's full Recent Form section
// (see isHit), just smaller. Fetched per-card rather than baked into
// /api/markets, since the underlying /api/game-log call is keyed by
// player+stat+opponent and reused as-is from the modal's own fetch path --
// no new backend endpoint needed.
//
// Lazy by viewport, not by grid: a full render (especially Best No-Vig,
// which combines cards from all 41 leagues in one grid) can be a few dozen
// statID cards at once, and fetching every one of them immediately used to
// fire that many game-log requests up front regardless of how many were
// actually visible. An IntersectionObserver instead only enqueues a card's
// fetch once it's scrolled near the viewport (rootMargin gives it a head
// start so the dots are usually ready by the time you actually see the
// card), and MINI_FORM_CONCURRENCY still caps how many of those run at
// once, in case a fast scroll or resize reveals many cards in one frame.
// Cached client-side by item.id so switching filters/sort/tabs (which
// re-renders the same cards) never refetches an already-loaded one, even
// if it's re-observed.
// Concurrency deliberately modest (was 4, lowered after a real slowdown):
// on a big grid (MLB alone can be 5,000+ items across ~30 different teams),
// even just the cards visible on first paint can span many distinct teams,
// each needing its own first-time (cold-cache) game-log fetch. At 4
// concurrent workers all racing for a shared 8-requests/minute budget right
// after a cache-wiping deploy, several would end up waiting the rate
// limiter's full 15s ceiling and surface as "Form unavailable" instead of
// data. 2 spreads the same total work out more gently, giving each request
// a better chance of landing within budget instead of several colliding at
// once.
const MINI_FORM_CONCURRENCY = 2;
const miniFormCache = new Map(); // item.id -> { games, h2h } | 'error'
const miniFormQueue = []; // { item, container }
let miniFormActiveWorkers = 0;

function pumpMiniFormQueue() {
  while (miniFormActiveWorkers < MINI_FORM_CONCURRENCY && miniFormQueue.length) {
    const { item, container } = miniFormQueue.shift();
    if (miniFormCache.has(item.id)) {
      paintMiniForm(item.id, container);
      continue;
    }
    miniFormActiveWorkers++;
    fetchGameLog({
      league: item.league,
      teamID: item.playerTeamID,
      playerID: item.playerID,
      statID: item.statID,
      opponentTeamID: item.opponentTeamID,
    })
      .then(({ games, h2h }) => miniFormCache.set(item.id, { games, h2h }))
      .catch(() => miniFormCache.set(item.id, 'error'))
      .then(() => {
        paintMiniForm(item.id, container);
        miniFormActiveWorkers--;
        pumpMiniFormQueue();
      });
  }
}

const miniFormObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      miniFormObserver.unobserve(entry.target);
      const itemId = entry.target.dataset.mini;
      const container = entry.target.closest('.card-grid');
      const item = state.items.find((i) => i.id === itemId) || state.noVigItems.find((i) => i.id === itemId);
      if (!item || !container) continue;
      if (miniFormCache.has(itemId)) {
        paintMiniForm(itemId, container);
      } else {
        miniFormQueue.push({ item, container });
        pumpMiniFormQueue();
      }
    }
  },
  // 100px, not the original 400px: a smaller margin means fewer cards count
  // as "about to be visible" on first paint -- on a large grid (MLB alone
  // can span ~30 different teams), 400px of pre-loading below the fold was
  // enough to queue up a whole extra row or two of cards immediately,
  // multiplying how many distinct teams' cold-cache fetches compete for the
  // shared rate-limit budget right when the page first loads. 100px still
  // gives fetches a small head start before a card is scrolled fully into
  // view, just a much smaller one.
  { rootMargin: '100px 0px' }
);

function miniFormRow(label, games, item, cap = 5) {
  const slice = games.slice(0, cap);
  if (!slice.length) {
    return `<div class="mini-form-row"><span class="mini-form-label">${label}</span><span class="mini-form-empty">No data</span></div>`;
  }
  const dots = slice
    .map((g) => {
      const hit = isHit(item, g.statValue);
      const cls = hit == null ? '' : hit ? 'hit' : 'miss';
      return `<span class="mini-dot ${cls}"></span>`;
    })
    .join('');
  const hits = slice.filter((g) => isHit(item, g.statValue)).length;
  const pct = Math.round((hits / slice.length) * 100);
  return `<div class="mini-form-row"><span class="mini-form-label">${label}</span>${dots}<span class="mini-form-rate">${hits}/${slice.length} (${pct}%)</span></div>`;
}

function paintMiniForm(itemId, container) {
  const slot = container.querySelector(`[data-mini="${itemId}"]`);
  if (!slot) return; // card isn't in this container (different tab/grid) or got filtered out since
  const cached = miniFormCache.get(itemId);
  slot.classList.remove('mini-form-loading');
  if (cached === 'error' || !cached) {
    slot.innerHTML = '<div class="mini-form-row mini-form-empty">Form unavailable</div>';
    return;
  }
  const item = state.items.find((i) => i.id === itemId) || state.noVigItems.find((i) => i.id === itemId);
  if (!item) return;
  slot.innerHTML = miniFormRow('L5', cached.games, item) + miniFormRow('H2H', cached.h2h, item);
}

function loadMiniForms(items, container) {
  // Anything already cached (from a previous render of the same item) can
  // paint immediately without waiting on the network -- or on scrolling
  // into view -- at all. Everything else is handed to miniFormObserver,
  // which enqueues the actual fetch only once its card is near the
  // viewport (see the observer's definition above for why).
  for (const item of items) {
    if (!item.statID) continue;
    if (miniFormCache.has(item.id)) {
      paintMiniForm(item.id, container);
      continue;
    }
    const slot = container.querySelector(`[data-mini="${item.id}"]`);
    if (slot) miniFormObserver.observe(slot);
  }
}

function renderGrid() {
  const items = getFilteredItems();
  el.empty.hidden = items.length !== 0 || state.loading;
  el.grid.innerHTML = state.loading ? loadingOverlay('Loading live odds…') : items.map(renderCard).join('');
  bindCardEvents(el.grid);
  if (!state.loading) loadMiniForms(items, el.grid);
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
    <h2>${formatItemNameHtml(item)}</h2>
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
  const pct = Math.round((hits / games.length) * 100);
  return `${hits}/${games.length} (${pct}%)`;
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

// Leagues where "Team A @ Team B" is really "Player A vs. Player B" -- a 1-
// on-1 individual matchup, not two separate teams. For these, a
// Moneyline/Spread item's Recent Form should show BOTH players side by
// side (each one's own win/margin history), not just whichever side this
// particular betting line happens to be quoting -- unlike a genuine team
// sport, where the other side's recent form is a separate, differently-
// keyed set of cards entirely.
const INDIVIDUAL_SPORT_LEAGUES = new Set(['ATP', 'WTA', 'UFC']);

function isHeadToHeadIndividualMarket(item) {
  return INDIVIDUAL_SPORT_LEAGUES.has(item.league) && (item.statID === 'team_win' || item.statID === 'team_margin');
}

// Server always renders non-prop, non-Total names as "{matchup} — {market}
// ({sideName}{line})" (see build_markets in server.py) -- the trailing
// parenthetical is exactly the display name of the side this item's line
// belongs to, e.g. "(J. Fearnley)".
function parseMoneylineSideName(item) {
  const match = item.name.match(/\(([^)]+)\)\s*$/);
  return match ? match[1] : null;
}

function matchupOtherSideName(item, sideName) {
  const [awayName, homeName] = item.matchup.split(' @ ');
  if (sideName === homeName) return awayName;
  if (sideName === awayName) return homeName;
  return null;
}

// For team_margin (spread), the two players' lines are mirror images of
// each other (home -3.5 <=> away +3.5) -- reusing isHit/formGuideDots/
// hitRateLabel/recentFormCaption for the OTHER player needs their line
// negated, or a "covered" dot would be checking the wrong side's number.
// team_win needs no such adjustment (isHit for it never reads item.line).
function otherSideHitTestItem(item) {
  if (item.statID === 'team_margin' && item.line != null) {
    return { ...item, line: -Number(item.line) };
  }
  return item;
}

function playerFormBlock(label, games, h2h, coverage, hitTestItem, displayItem) {
  const last5 = games.slice(0, 5);
  const last10 = games.slice(0, 10);
  const last5H2H = h2h.slice(0, 5);
  return `
    <div class="recent-form-player">
      <h4>${label}</h4>
      <div class="form-row"><span class="form-label">Last 5</span><span class="form-dots">${formGuideDots(last5, hitTestItem)}</span><span class="form-rate">${hitRateLabel(last5, hitTestItem)}</span></div>
      <div class="form-row"><span class="form-label">Last 10</span><span class="form-dots">${formGuideDots(last10, hitTestItem)}</span><span class="form-rate">${hitRateLabel(last10, hitTestItem)}</span></div>
      <div class="form-row"><span class="form-label">All seasons</span><span class="form-dots">${formGuideDots(games, hitTestItem)}</span><span class="form-rate">${hitRateLabel(games, hitTestItem)}</span></div>
      <div class="form-row"><span class="form-label">Last 5 H2H</span><span class="form-dots">${formGuideDots(last5H2H, hitTestItem)}</span><span class="form-rate">${hitRateLabel(last5H2H, hitTestItem)}</span></div>
      <div class="form-row"><span class="form-label">All-time H2H</span><span class="form-dots">${formGuideDots(h2h, hitTestItem)}</span><span class="form-rate">${hitRateLabel(h2h, hitTestItem)}</span></div>
      <p class="form-note">${recentFormCaption(hitTestItem)}</p>
      <p class="form-note">${coverageNote(coverage, games.length, displayItem)}</p>
    </div>`;
}

// Small colored-initials badge standing in for a team logo -- SportsGameOdds
// doesn't provide logo images at all (confirmed against their public API
// docs: a team object only has names + a primary/secondary brand color),
// so this uses that real color as the badge background with the team's own
// abbreviation on top, rather than a generic gray placeholder circle.
function teamBadge(abbrev, color) {
  if (!abbrev) return '';
  const bg = color || 'var(--border)';
  const fg = color ? '#ffffff' : 'var(--text-muted)';
  return `<span class="team-badge" style="background:${bg};color:${fg};">${abbrev.slice(0, 3)}</span>`;
}

function formatShortDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function groupGamesByYear(games) {
  const map = new Map();
  for (const g of games) {
    const year = new Date(g.date).getFullYear();
    if (Number.isNaN(year)) continue;
    if (!map.has(year)) map.set(year, []);
    map.get(year).push(g);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]); // oldest season first
}

// Hit Rate filter -- lets someone filter the whole grid down to props whose
// recent-form hit rate falls in a chosen range, over a chosen window (Last
// 5/10/20, all-time H2H, or a specific season). Works for every item with a
// statID regardless of stat type -- batter props (Hits, HR, RBI, Total
// Bases, ...) and pitcher props (Strikeouts, Walks Allowed, Earned Runs,
// ...) alike, since it's built entirely on the same isHit/game-log data
// every other stat already uses, not a stat-specific list.
const HIT_RATE_CURRENT_YEAR = new Date().getFullYear();
const HIT_RATE_WINDOWS = [
  { id: 'l5', label: 'L5' },
  { id: 'l10', label: 'L10' },
  { id: 'l20', label: 'L20' },
  { id: 'h2h', label: 'H2H' },
  { id: String(HIT_RATE_CURRENT_YEAR), label: String(HIT_RATE_CURRENT_YEAR) },
  { id: String(HIT_RATE_CURRENT_YEAR - 1), label: String(HIT_RATE_CURRENT_YEAR - 1) },
];

function computeHitRateForWindow(item, gamesData, windowId) {
  const { games, h2h } = gamesData;
  let subset;
  if (windowId === 'l5') subset = games.slice(0, 5);
  else if (windowId === 'l10') subset = games.slice(0, 10);
  else if (windowId === 'l20') subset = games.slice(0, 20);
  else if (windowId === 'h2h') subset = h2h;
  else {
    const year = Number(windowId);
    subset = games.filter((g) => new Date(g.date).getFullYear() === year);
  }
  if (!subset || !subset.length) return null;
  const hits = subset.filter((g) => isHit(item, g.statValue)).length;
  return Math.round((hits / subset.length) * 100);
}

// Eagerly fetches game logs for every item that doesn't already have one
// cached -- unlike mini-form/Recent Form, which only ever fetch what's
// actually visible or opened, the Hit Rate panel needs every candidate
// item's data up front so the histogram/slider/result-count are accurate
// immediately rather than only for cards that happen to have scrolled into
// view. Shares miniFormCache with those other features, so anything
// already fetched (e.g. from scrolling the grid earlier) doesn't refetch --
// this is also why the server-side rate limiter (see _sgo_rate_limit_wait
// in server.py) is essential now: this can realistically request game logs
// for dozens of items back to back, which the app never did in bulk before.
const HIT_RATE_FETCH_CONCURRENCY = 5;

async function ensureHitRateDataLoaded(items, onProgress) {
  const total = items.length;
  let done = items.filter((i) => miniFormCache.has(i.id)).length;
  onProgress(done, total);
  const targets = items.filter((i) => !miniFormCache.has(i.id));
  if (!targets.length) return;
  let idx = 0;
  async function worker() {
    while (idx < targets.length) {
      const item = targets[idx++];
      try {
        const { games, h2h } = await fetchGameLog({
          league: item.league,
          teamID: item.playerTeamID,
          playerID: item.playerID,
          statID: item.statID,
          opponentTeamID: item.opponentTeamID,
        });
        miniFormCache.set(item.id, { games, h2h });
      } catch {
        miniFormCache.set(item.id, 'error');
      }
      done++;
      onProgress(done, total);
    }
  }
  await Promise.all(Array.from({ length: HIT_RATE_FETCH_CONCURRENCY }, worker));
}

function hitRateHistogramBuckets(rates) {
  const buckets = new Array(10).fill(0);
  rates.forEach((v) => {
    const idx = Math.min(9, Math.max(0, Math.floor(v / 10)));
    buckets[idx]++;
  });
  return buckets;
}

function renderHitRatePanel() {
  const itemsInScope = getFilteredItems({ ignoreHitRate: true }).filter((i) => i.statID);

  // Nothing fetches until the user explicitly asks for it -- opening the
  // panel used to eagerly fetch every prop in the current view immediately,
  // which was fine for a small league but meant a real "Loading hit
  // rates... 380 / 5240" situation on a big one like MLB with no market-
  // type/stat filter narrowing it down first. Showing the count up front
  // and waiting for a click means the person can narrow scope with the
  // existing Market Type/Stat filters first if they want, rather than the
  // panel silently launching a few thousand requests the moment it opens.
  if (!state.hitRateStarted) {
    const big = itemsInScope.length > 500;
    el.modalContent.innerHTML = `
      <button class="modal-close" id="modal-close">&times;</button>
      <h2>Hit Rate Filter</h2>
      <p class="form-note">Filters player props by hit rate over a chosen window — covers every batter and pitcher stat (Hits, Home Runs, RBI, Strikeouts, Walks Allowed, Total Bases, and more), since it's built from the same game-log data every prop already uses.</p>
      <p class="form-note">This will fetch game-log data for all <strong>${itemsInScope.length}</strong> props currently shown.${big ? ' That\'s a lot — narrow it down with the Market Type or Stat filters first if you only care about a subset, or it may take a while given the API\'s rate limit.' : ''}</p>
      <div class="modal-actions">
        <button class="btn-secondary" id="hr-cancel">Cancel</button>
        <button class="btn-primary" id="hr-load">Load Hit Rates for ${itemsInScope.length} Props</button>
      </div>
    `;
    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('hr-cancel').addEventListener('click', closeModal);
    document.getElementById('hr-load').addEventListener('click', () => startHitRateLoad());
    return;
  }

  const rates = itemsInScope
    .map((i) => {
      const cached = miniFormCache.get(i.id);
      if (!cached || cached === 'error') return null;
      return computeHitRateForWindow(i, cached, state.hitRateWindow);
    })
    .filter((v) => v != null);
  const buckets = hitRateHistogramBuckets(rates);
  const maxBucket = Math.max(...buckets, 1);
  const matchCount = rates.filter((v) => v >= state.hitRateFrom && v <= state.hitRateTo).length;

  const windowTabsHtml = HIT_RATE_WINDOWS.map(
    (w) => `<button class="category-chip ${state.hitRateWindow === w.id ? 'active' : ''}" data-hr-window="${w.id}">${w.label}</button>`
  ).join('');

  const barsHtml = buckets
    .map((count, i) => {
      const bucketFrom = i * 10;
      const bucketTo = i * 10 + 10;
      const inRange = bucketTo > state.hitRateFrom && bucketFrom < state.hitRateTo;
      const heightPct = Math.max(Math.round((count / maxBucket) * 100), count > 0 ? 6 : 2);
      return `<div class="hr-hist-bar ${inRange ? 'in-range' : ''}" style="height:${heightPct}%" title="${bucketFrom}-${bucketTo}%: ${count} item${count === 1 ? '' : 's'}"></div>`;
    })
    .join('');

  const progressHtml = state.hitRateLoading
    ? `<p class="form-note">Loading hit rates… ${state.hitRateLoadedCount} / ${state.hitRateTotalCount}</p>`
    : '';

  el.modalContent.innerHTML = `
    <button class="modal-close" id="modal-close">&times;</button>
    <h2>Hit Rate Filter</h2>
    <p class="form-note">Filters player props by hit rate over the selected window — covers every batter and pitcher stat (Hits, Home Runs, RBI, Strikeouts, Walks Allowed, Total Bases, and more), since it's built from the same game-log data every prop already uses.</p>
    <div class="mlb-tab-group">${windowTabsHtml}</div>
    <div class="hr-range-row">
      <span>From <strong>${state.hitRateFrom}%</strong></span>
      <span>To <strong>${state.hitRateTo}%</strong></span>
    </div>
    <div class="hr-histogram">${barsHtml}</div>
    <div class="hr-slider-wrap">
      <input type="range" id="hr-from" min="0" max="100" step="1" value="${state.hitRateFrom}">
      <input type="range" id="hr-to" min="0" max="100" step="1" value="${state.hitRateTo}">
    </div>
    ${progressHtml}
    <div class="modal-actions">
      <button class="btn-secondary" id="hr-clear">Clear filter</button>
      <button class="btn-primary" id="hr-apply">Show ${matchCount} Results</button>
    </div>
  `;

  document.getElementById('modal-close').addEventListener('click', closeModal);
  el.modalContent.querySelectorAll('[data-hr-window]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.hitRateWindow = btn.dataset.hrWindow;
      renderHitRatePanel();
    });
  });
  const fromInput = document.getElementById('hr-from');
  const toInput = document.getElementById('hr-to');
  fromInput.addEventListener('input', () => {
    state.hitRateFrom = Math.min(Number(fromInput.value), state.hitRateTo);
    renderHitRatePanel();
  });
  toInput.addEventListener('input', () => {
    state.hitRateTo = Math.max(Number(toInput.value), state.hitRateFrom);
    renderHitRatePanel();
  });
  document.getElementById('hr-clear').addEventListener('click', () => {
    state.hitRateFilter = null;
    closeModal();
    render();
  });
  document.getElementById('hr-apply').addEventListener('click', () => {
    state.hitRateFilter = { window: state.hitRateWindow, from: state.hitRateFrom, to: state.hitRateTo };
    closeModal();
    render();
  });
}

async function startHitRateLoad() {
  const itemsInScope = getFilteredItems({ ignoreHitRate: true }).filter((i) => i.statID);
  state.hitRateStarted = true;
  state.hitRateLoading = true;
  state.hitRateLoadedCount = 0;
  state.hitRateTotalCount = itemsInScope.length;
  renderHitRatePanel();
  await ensureHitRateDataLoaded(itemsInScope, (done, total) => {
    state.hitRateLoadedCount = done;
    state.hitRateTotalCount = total;
    renderHitRatePanel();
  });
  state.hitRateLoading = false;
  renderHitRatePanel();
}

function openHitRatePanel() {
  el.modalBackdrop.hidden = false;
  state.hitRateStarted = false;
  state.hitRateLoading = false;
  state.hitRateLoadedCount = 0;
  state.hitRateTotalCount = 0;
  renderHitRatePanel();
}

// Quick-glance hit-rate grid above the chart: L5 / L10 / H2H, plus one
// entry per calendar year actually present in the game log (so a rookie's
// single-season history shows one year, a veteran's shows several) --
// computed entirely client-side from dates already in `games`, no extra
// endpoint needed.
function propChartQuickStats(item, games, h2h) {
  const yearGroups = groupGamesByYear(games);
  const entries = [
    { label: 'L5', games: games.slice(0, 5) },
    { label: 'L10', games: games.slice(0, 10) },
    { label: 'H2H', games: h2h },
    ...yearGroups.map(([year, yGames]) => ({ label: String(year), games: yGames })),
  ];
  return entries
    .map(({ label, games: g }) => {
      if (!g.length) {
        return `<div class="prop-quickstat"><span class="prop-quickstat-label">${label}</span><span class="prop-quickstat-value">—</span></div>`;
      }
      const hits = g.filter((x) => isHit(item, x.statValue)).length;
      const pct = Math.round((hits / g.length) * 100);
      return `<div class="prop-quickstat"><span class="prop-quickstat-label">${label}</span><span class="prop-quickstat-value ${pct >= 50 ? 'good' : 'bad'}">${pct}%</span></div>`;
    })
    .join('');
}

// Shared bar-chart geometry -- the one visual language for "recent form"
// everywhere in the app: the Markets tab's player-prop chart, the MLB
// Matchups player modal's Last 5/10/20 views, and the KBO Matchups batter
// game logs all call this same function rather than each drawing their own
// bars, so a change here (or a bug fix) applies everywhere at once instead
// of needing to be repeated three times.
//
// `points` must already be in left-to-right (oldest-to-newest) display
// order. Each point: { value, colorClass, color, label, tooltipHtml }.
// colorClass is a CSS class ('hit'/'miss'/'neutral', matching .prop-bar.*
// in style.css); color is an optional inline hex that takes priority over
// colorClass (used where color comes from real data, like a team's brand
// color or the KBO workbook's 4-tier AVG bands, rather than a fixed
// palette). label defaults to the raw value if omitted.
function buildBarChartSvg(points, { referenceLine = null, height = 220 } = {}) {
  if (!points.length) return '';
  const rawValues = points.map((p) => p.value ?? 0);
  const allValues = referenceLine != null ? [...rawValues, referenceLine, 0] : [...rawValues, 0];
  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);
  const valueRange = maxVal - minVal || 1;
  const headroom = valueRange * 0.12;
  const scaleMin = minVal - headroom;
  const scaleMax = maxVal + headroom;
  const scaleRange = scaleMax - scaleMin;
  const chartW = 700;
  const chartH = height;
  const padX = 8;
  const padTop = 16;
  const padBottom = 16;
  const plotW = chartW - padX * 2;
  const plotH = chartH - padTop - padBottom;
  const barGap = 4;
  const barW = Math.max(5, plotW / points.length - barGap);
  const yPos = (v) => padTop + plotH - ((v - scaleMin) / scaleRange) * plotH;
  const zeroY = yPos(0);

  const bars = points
    .map((p, i) => {
      const x = padX + i * (barW + barGap);
      const v = p.value ?? 0;
      const vY = yPos(v);
      const isNeg = v < 0;
      const barTop = isNeg ? zeroY : vY;
      const barBottom = isNeg ? vY : zeroY;
      const barH = Math.max(barBottom - barTop, 1);
      const cls = p.colorClass || 'neutral';
      const styleAttr = p.color ? ` style="fill:${p.color};"` : '';
      const labelY = isNeg ? barBottom + 13 : barTop - 5;
      const labelText = p.label != null ? p.label : v;
      return `<g class="prop-bar-group" data-idx="${i}">
        <rect class="prop-bar-hit-area" x="${x - barGap / 2}" y="${padTop}" width="${barW + barGap}" height="${plotH}" fill="transparent"/>
        <rect class="prop-bar ${cls}" x="${x}" y="${barTop}" width="${barW}" height="${barH}" rx="3"${styleAttr}/>
        <text class="prop-bar-value ${cls}" x="${x + barW / 2}" y="${labelY}" text-anchor="middle">${labelText}</text>
      </g>`;
    })
    .join('');

  const zeroLine = minVal < 0
    ? `<line class="prop-zero-marker" x1="${padX}" x2="${chartW - padX}" y1="${zeroY}" y2="${zeroY}"/>`
    : '';
  const dashedLine = referenceLine != null
    ? `<line class="prop-line-marker" x1="${padX}" x2="${chartW - padX}" y1="${yPos(referenceLine)}" y2="${yPos(referenceLine)}"/>`
    : '';

  return `<svg class="prop-chart-svg" viewBox="0 0 ${chartW} ${chartH}" preserveAspectRatio="none">${zeroLine}${dashedLine}${bars}</svg>`;
}

// Wires up hover/move/leave listeners on each bar once buildBarChartSvg's
// markup is actually in the DOM. `points` must be the exact same array
// (same order) passed to buildBarChartSvg for this container, since bars
// are matched back to points purely by index.
function bindBarChartTooltip(container, points) {
  const svg = container.querySelector('.prop-chart-svg');
  const tooltip = container.querySelector('.prop-chart-tooltip');
  const wrap = container.querySelector('.prop-chart-wrap');
  if (!svg || !tooltip || !wrap) return;

  svg.querySelectorAll('.prop-bar-group').forEach((group) => {
    const p = points[Number(group.dataset.idx)];
    if (!p) return;
    const show = (evt) => {
      const rect = wrap.getBoundingClientRect();
      const x = evt.clientX - rect.left;
      const y = evt.clientY - rect.top;
      tooltip.innerHTML = p.tooltipHtml || '';
      tooltip.hidden = false;
      tooltip.style.left = `${Math.min(Math.max(x, 64), rect.width - 64)}px`;
      tooltip.style.top = `${Math.max(y - 14, 8)}px`;
    };
    const hide = () => { tooltip.hidden = true; };
    group.addEventListener('mouseenter', show);
    group.addEventListener('mousemove', show);
    group.addEventListener('mouseleave', hide);
  });
}

const PROP_CHART_WINDOW = 20;

// Builds the ordered {value, colorClass, tooltipHtml} points for the
// Markets tab's player-prop chart -- shared between propChartBlock (which
// draws the SVG) and bindPropChartTooltip (which wires up hover), so those
// two never drift out of sync.
function buildPropChartPoints(item, games) {
  const windowGames = games.slice(0, PROP_CHART_WINDOW);
  const chartGames = [...windowGames].reverse();
  return chartGames.map((g) => {
    const hit = isHit(item, g.statValue);
    const cls = hit == null ? 'neutral' : hit ? 'hit' : 'miss';
    const scoreLine = g.ownScore != null && g.opponentScore != null
      ? `<div class="prop-tooltip-score">${teamBadge(g.ownAbbrev, g.ownColor)} ${g.ownName || 'Own'} ${g.ownScore} : ${g.opponentScore} ${g.opponentName || 'Opp'} ${teamBadge(g.opponentAbbrev, g.opponentColor)}</div>`
      : `<div class="prop-tooltip-score">${teamBadge(g.opponentAbbrev, g.opponentColor)} vs ${g.opponentName || 'Opponent'}</div>`;
    return {
      value: g.statValue ?? 0,
      colorClass: cls,
      tooltipHtml: `
        <div class="prop-tooltip-date">${formatShortDate(g.date)}</div>
        ${scoreLine}
        <div class="prop-tooltip-stat"><span>${item.statLabel || 'Value'}</span><strong>${g.statValue}</strong></div>
      `,
    };
  });
}

// Per-game bar chart -- each bar is one game's stat value, colored by
// isHit (same hit/miss logic the old dot-based view used), with a dashed
// line at the prop's own betting line and a value label above each bar.
// Hover details are wired up separately by bindPropChartTooltip once this
// HTML is actually in the DOM (an SVG string alone can't carry live event
// listeners).
function propChartBlock(item, games, h2h, coverage) {
  const quickStatsHtml = propChartQuickStats(item, games, h2h);
  const windowGames = games.slice(0, PROP_CHART_WINDOW);
  const hits = windowGames.filter((g) => isHit(item, g.statValue)).length;
  const hitPct = windowGames.length ? Math.round((hits / windowGames.length) * 100) : 0;
  const values = windowGames.map((g) => g.statValue).filter((v) => v != null);
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const sortedVals = [...values].sort((a, b) => a - b);
  const median = sortedVals.length
    ? sortedVals.length % 2
      ? sortedVals[(sortedVals.length - 1) / 2]
      : (sortedVals[sortedVals.length / 2 - 1] + sortedVals[sortedVals.length / 2]) / 2
    : null;

  const headerHtml = `
    <div class="prop-chart-header">
      <div class="prop-chart-title-row">
        <span class="prop-chart-window">Last ${windowGames.length || PROP_CHART_WINDOW}</span>
        ${windowGames.length ? `<span class="prop-chart-hitrate ${hitPct >= 50 ? 'good' : 'bad'}">${hitPct}%</span><span class="prop-chart-hitrate-detail">${hits} of ${windowGames.length}</span>` : ''}
      </div>
      <div class="prop-quickstat-grid">${quickStatsHtml}</div>
    </div>`;

  const points = buildPropChartPoints(item, games);
  if (!points.length) {
    return `${headerHtml}<p class="form-note">No recent games found.</p><p class="form-note">${coverageNote(coverage, games.length, item)}</p>`;
  }

  const line = item.line != null ? Number(item.line) : null;
  const svgHtml = buildBarChartSvg(points, { referenceLine: line });
  const orderedGames = [...windowGames].reverse();
  const firstDate = formatShortDate(orderedGames[0].date);
  const lastDate = formatShortDate(orderedGames[orderedGames.length - 1].date);

  return `
    ${headerHtml}
    <div class="prop-chart-avgmed">Average: <strong>${avg != null ? avg.toFixed(2) : '—'}</strong> &nbsp; Median: <strong>${median != null ? median : '—'}</strong></div>
    <div class="prop-chart-wrap">
      ${svgHtml}
      <div class="prop-chart-xaxis"><span>${firstDate}</span><span>${lastDate}</span></div>
      <div class="prop-chart-tooltip" hidden></div>
    </div>
    <p class="form-note">Bars show each game's ${item.statLabel || 'value'}${line != null ? `; dashed line marks the ${line} line` : ''}. Hover a bar for matchup details.</p>
    <p class="form-note">${coverageNote(coverage, games.length, item)}</p>
  `;
}

// Wires up hover for propChartBlock's chart once its HTML is actually in
// the DOM -- recomputes the same points array (buildPropChartPoints is
// deterministic given the same item/games) rather than threading it
// through as a separate parameter, so this and propChartBlock can never
// draw from two different orderings.
function bindPropChartTooltip(container, item, games) {
  bindBarChartTooltip(container, buildPropChartPoints(item, games));
}

async function renderRecentForm(item) {
  const container = document.getElementById('recent-form');
  if (!container) return;
  try {
    if (isHeadToHeadIndividualMarket(item)) {
      const sideName = parseMoneylineSideName(item) || 'This side';
      const otherName = matchupOtherSideName(item, sideName) || 'Opponent';
      const [primary, secondary] = await Promise.all([
        fetchGameLog({
          league: item.league,
          teamID: item.playerTeamID,
          playerID: item.playerID,
          statID: item.statID,
          opponentTeamID: item.opponentTeamID,
        }),
        fetchGameLog({
          league: item.league,
          teamID: item.opponentTeamID,
          playerID: item.playerID,
          statID: item.statID,
          opponentTeamID: item.playerTeamID,
        }),
      ]);
      container.innerHTML = `
        <h3>Recent form</h3>
        <p class="form-note">Shown separately for each player in this 1-on-1 matchup.</p>
        ${playerFormBlock(sideName, primary.games, primary.h2h, primary.coverage, item, item)}
        ${playerFormBlock(otherName, secondary.games, secondary.h2h, secondary.coverage, otherSideHitTestItem(item), item)}
      `;
      return;
    }
    const { games, h2h, coverage } = await fetchGameLog({
      league: item.league,
      teamID: item.playerTeamID,
      playerID: item.playerID,
      statID: item.statID,
      opponentTeamID: item.opponentTeamID,
    });
    container.innerHTML = `<h3>Recent form</h3>${propChartBlock(item, games, h2h, coverage)}`;
    bindPropChartTooltip(container, item, games);
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
  el.hitRateFilterBtn.classList.toggle('active', !!state.hitRateFilter);
  el.hitRateBadge.hidden = !state.hitRateFilter;
  if (state.hitRateFilter) {
    el.hitRateBadge.textContent = `${state.hitRateFilter.from}-${state.hitRateFilter.to}%`;
  }
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
el.hitRateFilterBtn.addEventListener('click', () => openHitRatePanel());
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

// Local-calendar-day key (not a locale-formatted string) purely for
// grouping/sorting games into the new Date dropdown -- YYYY-MM-DD sorts
// correctly as a plain string, unlike most locale date formats.
function localDateKey(iso) {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDateOnlyLabel(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatTimeOnlyLabel(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// Builds the Date dropdown's options from whatever games are currently
// loaded, one option per distinct calendar day (not per game) -- a busy
// day with 10+ MLB games still collapses to a single date entry.
function renderMlbDateSelect() {
  const dateKeys = [...new Set(state.mlbGames.map((g) => localDateKey(g.startsAt)))].sort();
  el.mlbDateSelect.innerHTML = dateKeys
    .map((key) => {
      const sample = state.mlbGames.find((g) => localDateKey(g.startsAt) === key);
      return `<option value="${key}">${formatDateOnlyLabel(sample.startsAt)}</option>`;
    })
    .join('');
}

// Builds the Game dropdown's options from only the games on
// state.mlbSelectedDate -- the date's already chosen via the dropdown
// above, so each option just needs the matchup and kickoff time, not the
// full date+time formatGameLabel used to show.
function renderMlbGameSelectForDate() {
  const gamesForDate = state.mlbGames.filter((g) => localDateKey(g.startsAt) === state.mlbSelectedDate);
  el.mlbGameSelect.innerHTML = gamesForDate
    .map((g) => `<option value="${gameKey(g)}">${g.matchup} — ${formatTimeOnlyLabel(g.startsAt)}</option>`)
    .join('');
  if (gamesForDate.length) {
    state.mlbSelectedGameKey = gameKey(gamesForDate[0]);
    el.mlbGameSelect.value = state.mlbSelectedGameKey;
  }
}

async function loadMlbGames() {
  el.mlbDateSelect.innerHTML = '';
  el.mlbGameSelect.innerHTML = '<option>Loading games…</option>';
  try {
    state.mlbGames = await fetchMlbGames();
    if (state.mlbGames.length === 0) {
      el.mlbGameSelect.innerHTML = '<option>No upcoming MLB games found</option>';
      el.mlbMatchupContent.innerHTML = '';
      return;
    }
    renderMlbDateSelect();
    state.mlbSelectedDate = localDateKey(state.mlbGames[0].startsAt);
    el.mlbDateSelect.value = state.mlbSelectedDate;
    renderMlbGameSelectForDate();
    await loadMlbMatchup();
  } catch (err) {
    el.mlbGameSelect.innerHTML = '<option>Error loading games</option>';
    el.mlbMatchupContent.innerHTML = `<p class="form-note">Could not load MLB games (${err.message}).</p>`;
  }
}

// batter.id (string, from card dataset) -> { batter, pitcherId, opponentTeamID } --
// populated whenever pitcherCard renders a lineup, read back when a card is
// clicked. A plain module-level Map rather than embedding everything in
// data-* attributes, since pitcherId/opponentTeamID are shared context for a
// whole side's lineup, not per-card values worth re-serializing into the DOM.
const mlbBatterContext = new Map();

function mlbBatterCard(b) {
  const c = b.stats && b.stats.career;
  const fmt = (v) => (v != null ? v.toFixed(3).replace(/^0/, '') : '—');
  const snapshot = c
    ? `${fmt(c.avg)} AVG vs. this pitcher (career) · ${c.homeRuns ?? 0} HR`
    : 'Tap for full splits & recent form';
  // MLB batters aren't tied to a single betting line the way a prop item
  // is, so they get their own watchlist-id namespace (mlb-player-{id})
  // rather than reusing item.id -- shares the exact same state.watchlist
  // Set/localStorage/header count as every other star in the app, just
  // keyed distinctly so a batter and some unrelated prop can never collide.
  const watchId = `mlb-player-${b.id}`;
  const isWatched = state.watchlist.has(watchId);
  return `<article class="item-card mlb-player-card" data-batter-id="${b.id}">
    <button class="star-btn ${isWatched ? 'active' : ''}" data-star="${watchId}" title="Toggle watchlist">${starIcon(isWatched)}</button>
    <div class="card-top"><span class="card-category">${b.position || 'Batter'}</span></div>
    <div class="item-name">${b.fullName}</div>
    <div class="rating-row">${snapshot}</div>
  </article>`;
}

function pitcherCard(title, sideData, opponentTeamID) {
  if (!sideData) {
    return `<div class="mlb-pitcher-card"><h3>${title}</h3><p class="mlb-subtitle">Probable pitcher not yet announced.</p></div>`;
  }
  if (sideData.batters.length === 0) {
    return `<div class="mlb-pitcher-card"><h3>${sideData.pitcher.fullName}</h3><p class="mlb-subtitle">No career at-bats found against this lineup.</p></div>`;
  }
  sideData.batters.forEach((b) => {
    mlbBatterContext.set(String(b.id), { batter: b, pitcherId: sideData.pitcher.id, opponentTeamID });
  });
  return `<div class="mlb-pitcher-card">
    <h3>${sideData.pitcher.fullName}</h3>
    <p class="mlb-subtitle">${title}</p>
    <div class="card-grid mlb-player-grid">${sideData.batters.map(mlbBatterCard).join('')}</div>
  </div>`;
}

function bindMlbPlayerCards() {
  el.mlbMatchupContent.querySelectorAll('[data-batter-id]').forEach((card) => {
    card.addEventListener('click', () => {
      const ctx = mlbBatterContext.get(card.dataset.batterId);
      if (ctx) openMlbPlayerModal(ctx.batter, ctx.pitcherId, ctx.opponentTeamID);
    });
  });
  el.mlbMatchupContent.querySelectorAll('.star-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWatchlist(btn.dataset.star);
      // toggleWatchlist's own render() rebuilds the Markets tab's DOM (and
      // the header count) but never touches the MLB tab's already-rendered
      // cards -- patch this one button in place rather than re-fetching
      // the whole matchup just to reflect one star's new state.
      const isWatched = state.watchlist.has(btn.dataset.star);
      btn.classList.toggle('active', isWatched);
      btn.innerHTML = starIcon(isWatched);
    });
  });
}

// Stat-category tabs: which column(s) get highlighted in whichever
// view-tab's table is currently showing. 'hri' has no single underlying
// field -- it's Hits+Runs+RBI combined, so it highlights all three source
// columns at once rather than introducing a synthetic column of its own.
const MLB_STAT_TABS = [
  { id: 'hits', label: 'Hits', fields: ['hits'] },
  { id: 'runs', label: 'Runs', fields: ['runs'] },
  { id: 'rbi', label: "RBI's", fields: ['rbi'] },
  { id: 'hri', label: 'H+R+RBI', fields: ['hri'] },
  { id: 'hr', label: 'HRs', fields: ['homeRuns'] },
  { id: 'bb', label: 'Batter Balls', fields: ['walks'] },
  { id: 'k', label: 'Batter Strikes', fields: ['strikeouts'] },
  { id: 'pa', label: 'Plate Appearance', fields: ['plateAppearances'] },
];

function mlbHighlightFields(statTabId) {
  return (MLB_STAT_TABS.find((t) => t.id === statTabId) || {}).fields || [];
}

// Career/recent-style aggregate table -- used by both the Head 2 Head (vs
// team) and Head 2 Head vs Pitcher view tabs, since both return the same
// {career, recent, recentSeasons} shape from the backend. Also reused for
// the single-row {year} Season view tabs by passing just one row.
function mlbHri(stat) {
  return (stat.hits ?? 0) + (stat.runs ?? 0) + (stat.rbi ?? 0);
}

function mlbSplitTable(rows, highlightFields) {
  const fmt = (v) => (v != null ? v.toFixed(3).replace(/^0/, '') : '—');
  const cols = [
    { key: 'plateAppearances', label: 'PA' }, { key: 'atBats', label: 'AB' },
    { key: 'hits', label: 'H' }, { key: 'runs', label: 'R' }, { key: 'rbi', label: 'RBI' },
    { key: 'hri', label: 'H+R+RBI', compute: mlbHri },
    { key: 'homeRuns', label: 'HR' }, { key: 'walks', label: 'BB' }, { key: 'strikeouts', label: 'K' },
    { key: 'avg', label: 'AVG', rate: true }, { key: 'obp', label: 'OBP', rate: true },
    { key: 'slg', label: 'SLG', rate: true }, { key: 'ops', label: 'OPS', rate: true },
  ];
  const headerRow = `<tr><th>Window</th>${cols.map((c) => `<th class="${highlightFields.includes(c.key) ? 'mlb-col-highlight' : ''}">${c.label}</th>`).join('')}</tr>`;
  const bodyRows = rows
    .map(({ label, stat }) => {
      if (!stat) return `<tr class="mlb-row-empty"><td class="mlb-window-label">${label}</td><td colspan="${cols.length}">No data</td></tr>`;
      const cells = cols
        .map((c) => `<td class="${highlightFields.includes(c.key) ? 'mlb-col-highlight' : ''}">${c.rate ? fmt(stat[c.key]) : c.compute ? c.compute(stat) : stat[c.key] ?? 0}</td>`)
        .join('');
      return `<tr><td class="mlb-window-label">${label}</td>${cells}</tr>`;
    })
    .join('');
  return `<div class="mlb-table-wrap"><table class="mlb-table"><thead>${headerRow}</thead><tbody>${bodyRows}</tbody></table></div>`;
}

// Per-game log table -- used by the Last 5/10/20 view tabs, all three
// sliced from the same fetched games array (see fetchMlbPlayerSplits).
function mlbGameLogTable(games, highlightFields, cap) {
  if (!games || !games.length) return '<p class="form-note">No games in this window.</p>';
  const slice = games.slice(0, cap);
  const cols = [
    { key: 'plateAppearances', label: 'PA' }, { key: 'atBats', label: 'AB' },
    { key: 'hits', label: 'H' }, { key: 'runs', label: 'R' }, { key: 'rbi', label: 'RBI' },
    { key: 'hri', label: 'H+R+RBI', compute: mlbHri },
    { key: 'homeRuns', label: 'HR' }, { key: 'walks', label: 'BB' }, { key: 'strikeouts', label: 'K' },
  ];
  const headerRow = `<tr><th>Date</th><th>Opp</th>${cols.map((c) => `<th class="${highlightFields.includes(c.key) ? 'mlb-col-highlight' : ''}">${c.label}</th>`).join('')}</tr>`;
  const bodyRows = slice
    .map((g) => {
      const cells = cols.map((c) => `<td class="${highlightFields.includes(c.key) ? 'mlb-col-highlight' : ''}">${c.compute ? c.compute(g) : g[c.key] ?? 0}</td>`).join('');
      return `<tr><td>${g.date || '—'}</td><td>${g.opponent || '—'}</td>${cells}</tr>`;
    })
    .join('');
  return `<div class="mlb-table-wrap"><table class="mlb-table"><thead>${headerRow}</thead><tbody>${bodyRows}</tbody></table></div>`;
}

// Chart points for the MLB player modal's Last 5/10/20 views -- one point
// per game, valued by whichever stat tab is currently selected (H+R+RBI
// computed on the fly like everywhere else that stat's used). No betting
// line exists in this context (unlike the Markets tab's props), so bars
// share one neutral color rather than a hit/miss split -- consistent with
// the same accent-colored, un-graded style the MLB modal's tables already
// use (see .mlb-col-highlight) rather than borrowing green/red semantics
// that wouldn't mean anything here.
function mlbGameLogChartPoints(games, cap, highlightFields) {
  const slice = games.slice(0, cap);
  const ordered = [...slice].reverse(); // most-recent-first -> oldest-to-newest for the chart
  const label = highlightFields.length > 1 ? 'H+R+RBI' : (MLB_STAT_TABS.find((t) => t.fields === highlightFields) || {}).label || highlightFields[0];
  return ordered.map((g) => {
    const value = highlightFields.length > 1 ? mlbHri(g) : g[highlightFields[0]] ?? 0;
    return {
      value,
      colorClass: 'neutral',
      tooltipHtml: `
        <div class="prop-tooltip-date">${g.date || ''}</div>
        <div class="prop-tooltip-score">vs ${g.opponent || 'Opponent'}</div>
        <div class="prop-tooltip-stat"><span>${label}</span><strong>${value}</strong></div>
      `,
    };
  });
}

const MLB_VIEW_TAB_IDS = ['h2h', 'h2hPitcher', 'last5', 'last10', 'last20', 'season0', 'season1'];

async function openMlbPlayerModal(batter, pitcherId, opponentTeamID) {
  // Selected tabs persist across different batters/cards within the same
  // session -- clicking through a lineup keeps whatever stat/view you were
  // just looking at instead of resetting every time.
  const prevStatTab = state.mlbPlayerModal ? state.mlbPlayerModal.statTab : 'hits';
  const prevViewTab = state.mlbPlayerModal ? state.mlbPlayerModal.viewTab : 'h2h';
  state.mlbPlayerModal = { batter, statTab: prevStatTab, viewTab: prevViewTab, splits: null, loading: true, error: null };
  el.modalBackdrop.hidden = false;
  renderMlbPlayerModal();
  try {
    const splits = await fetchMlbPlayerSplits({ batterID: batter.id, pitcherID: pitcherId, opponentTeamID });
    state.mlbPlayerModal.splits = splits;
  } catch (err) {
    state.mlbPlayerModal.error = err.message;
  }
  state.mlbPlayerModal.loading = false;
  renderMlbPlayerModal();
}

function renderMlbPlayerModal() {
  const m = state.mlbPlayerModal;
  if (!m) return;
  const highlightFields = mlbHighlightFields(m.statTab);
  const seasons = (m.splits && m.splits.seasons) || [];

  const statTabsHtml = MLB_STAT_TABS.map(
    (t) => `<button class="category-chip ${m.statTab === t.id ? 'active' : ''}" data-stat-tab="${t.id}">${t.label}</button>`
  ).join('');

  const seasonLabel = (idx) => (seasons[idx] && seasons[idx].year ? `${seasons[idx].year} Season` : idx === 0 ? 'This Season' : 'Last Season');
  const viewTabDefs = [
    { id: 'h2h', label: 'Head 2 Head' },
    { id: 'h2hPitcher', label: 'Head 2 Head vs Pitcher' },
    { id: 'last5', label: 'Last 5' },
    { id: 'last10', label: 'Last 10' },
    { id: 'last20', label: 'Last 20' },
    { id: 'season0', label: seasonLabel(0) },
    { id: 'season1', label: seasonLabel(1) },
  ];
  const viewTabsHtml = viewTabDefs
    .map((t) => `<button class="category-chip ${m.viewTab === t.id ? 'active' : ''}" data-view-tab="${t.id}">${t.label}</button>`)
    .join('');

  let contentHtml;
  let mlbModalChartPoints = null;
  if (m.loading) {
    contentHtml = loadingOverlay('Loading splits…');
  } else if (m.error) {
    contentHtml = `<p class="form-note">Could not load splits (${m.error}).</p>`;
  } else if (!m.splits) {
    contentHtml = '<p class="form-note">No data available.</p>';
  } else if (m.viewTab === 'h2h') {
    const v = m.splits.vsTeam;
    contentHtml = v
      ? mlbSplitTable(
          [
            { label: 'Career', stat: v.career },
            { label: v.recentSeasons && v.recentSeasons.length ? `Last ${v.recentSeasons.length} szn` : 'Recent', stat: v.recent },
          ],
          highlightFields
        )
      : '<p class="form-note">No career at-bats found against this opponent.</p>';
  } else if (m.viewTab === 'h2hPitcher') {
    const v = m.splits.vsPitcher;
    contentHtml = v
      ? mlbSplitTable(
          [
            { label: 'Career', stat: v.career },
            { label: v.recentSeasons && v.recentSeasons.length ? `Last ${v.recentSeasons.length} szn` : 'Recent', stat: v.recent },
          ],
          highlightFields
        )
      : '<p class="form-note">No career at-bats found against this pitcher (or a probable pitcher hasn\'t been announced yet).</p>';
  } else if (m.viewTab === 'last5' || m.viewTab === 'last10' || m.viewTab === 'last20') {
    const cap = { last5: 5, last10: 10, last20: 20 }[m.viewTab];
    const points = mlbGameLogChartPoints(m.splits.games || [], cap, highlightFields);
    mlbModalChartPoints = points;
    contentHtml = points.length
      ? `<div class="prop-chart-wrap">${buildBarChartSvg(points, { height: 160 })}<div class="prop-chart-tooltip" hidden></div></div>${mlbGameLogTable(m.splits.games, highlightFields, cap)}`
      : '<p class="form-note">No games in this window.</p>';
  } else {
    const idx = m.viewTab === 'season0' ? 0 : 1;
    const season = seasons[idx];
    contentHtml = season
      ? mlbSplitTable([{ label: `${season.year}`, stat: season.stats }], highlightFields)
      : '<p class="form-note">No season data available.</p>';
  }

  el.modalContent.innerHTML = `
    <button class="modal-close" id="modal-close">&times;</button>
    <span class="card-category">MLB · Batter</span>
    <h2>${m.batter.fullName}</h2>
    <div class="rating-row">${m.batter.position || ''}</div>
    <div class="mlb-tab-group">${statTabsHtml}</div>
    <div class="mlb-tab-group mlb-view-tab-group">${viewTabsHtml}</div>
    <div class="mlb-modal-body">${contentHtml}</div>
  `;
  if (mlbModalChartPoints) bindBarChartTooltip(el.modalContent, mlbModalChartPoints);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  el.modalContent.querySelectorAll('[data-stat-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.mlbPlayerModal.statTab = btn.dataset.statTab;
      renderMlbPlayerModal();
    });
  });
  el.modalContent.querySelectorAll('[data-view-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.mlbPlayerModal.viewTab = btn.dataset.viewTab;
      renderMlbPlayerModal();
    });
  });
}

async function loadMlbMatchup() {
  const game = state.mlbGames.find((g) => gameKey(g) === state.mlbSelectedGameKey);
  if (!game) return;
  el.mlbMatchupContent.innerHTML = loadingOverlay('Loading matchup data…');
  mlbBatterContext.clear();
  try {
    const [awayName, homeName] = game.matchup.split(' @ ');
    const data = await fetchMlbMatchup(game);
    state.mlbData = data;
    // Away hitters face the home team's pitcher, so their Head 2 Head
    // (vs-team) view should compare them against the HOME team -- and
    // vice versa for home hitters vs. the away team.
    el.mlbMatchupContent.innerHTML =
      pitcherCard(`vs. ${awayName} hitters`, data.homePitcherVsAwayHitters, game.homeTeamID) +
      pitcherCard(`vs. ${homeName} hitters`, data.awayPitcherVsHomeHitters, game.awayTeamID);
    bindMlbPlayerCards();
  } catch (err) {
    el.mlbMatchupContent.innerHTML = `<p class="form-note">Could not load matchup data (${err.message}).</p>`;
  }
}

function renderKboDateSelect() {
  const dateKeys = [...new Set(state.kboGames.map((g) => localDateKey(g.startsAt)))].sort();
  el.kboDateSelect.innerHTML = dateKeys
    .map((key) => {
      const sample = state.kboGames.find((g) => localDateKey(g.startsAt) === key);
      return `<option value="${key}">${formatDateOnlyLabel(sample.startsAt)}</option>`;
    })
    .join('');
}

function renderKboGameSelectForDate() {
  const gamesForDate = state.kboGames.filter((g) => localDateKey(g.startsAt) === state.kboSelectedDate);
  el.kboGameSelect.innerHTML = gamesForDate
    .map((g) => `<option value="${gameKey(g)}">${g.matchup} — ${formatTimeOnlyLabel(g.startsAt)}</option>`)
    .join('');
  if (gamesForDate.length) {
    state.kboSelectedGameKey = gameKey(gamesForDate[0]);
    el.kboGameSelect.value = state.kboSelectedGameKey;
  }
}

async function loadKboGames() {
  el.kboDateSelect.innerHTML = '';
  el.kboGameSelect.innerHTML = '<option>Loading games…</option>';
  try {
    state.kboGames = await fetchKboGames();
    if (state.kboGames.length === 0) {
      el.kboGameSelect.innerHTML = '<option>No upcoming KBO games found</option>';
      el.kboMatchupContent.innerHTML = '';
      return;
    }
    renderKboDateSelect();
    state.kboSelectedDate = localDateKey(state.kboGames[0].startsAt);
    el.kboDateSelect.value = state.kboSelectedDate;
    renderKboGameSelectForDate();
    await loadKboMatchup();
  } catch (err) {
    el.kboGameSelect.innerHTML = '<option>Error loading games</option>';
    el.kboMatchupContent.innerHTML = `<p class="form-note">Could not load KBO games (${err.message}).</p>`;
  }
}

// AVG-based row tint, matching the KBO Excel workbook's "Batter vs Pitching
// Team" tab exactly: same 4 thresholds, same 4 colors. There, the whole
// AB..AVG range gets one shared color driven by the AVG cell; same idea
// here, applied to the AB/H/R/RBI/HR/AVG cells of each row.
function kboAvgColor(avg) {
  if (avg == null) return null;
  if (avg < 0.3) return '#F4A6A6';
  if (avg < 0.45) return '#F8CBAD';
  if (avg < 0.65) return '#FFF2A6';
  return '#A9D18E';
}

// Per-game row color, matching the Excel workbook's Game Log tab exactly:
// same 4 thresholds (on the combined H+R+RBI for that one game), same 4
// colors. Distinct from kboAvgColor above (which bands a rate stat, AVG)
// -- this bands a per-game counting-stat total instead, so the boundaries
// are on whole numbers (0, 1, 2, >2) rather than fractions.
function kboGameColor(g) {
  const total = g.h + g.r + g.rbi;
  if (total < 1) return '#F4A6A6';
  if (total === 1) return '#F8CBAD';
  if (total === 2) return '#FFF2A6';
  return '#A9D18E'; // > 2.5 in the workbook's formula, but totals are always whole numbers so ">2" is equivalent
}

function kboBatterRow(b) {
  const s = b.stats.vsOpponent;
  const fmt = (v) => (v != null ? v.toFixed(3).replace(/^0/, '') : '—');
  if (!s) {
    return `<tr class="kbo-row-empty"><td>${b.fullName}</td><td colspan="7">No career at-bats vs. this opponent</td></tr>`;
  }
  const bg = kboAvgColor(s.avg);
  const style = bg ? ` style="background-color:${bg};"` : '';
  return `<tr>
    <td>${b.fullName}</td>
    <td>${s.gamesFound}</td>
    <td${style}>${s.atBats}</td>
    <td${style}>${s.hits}</td>
    <td${style}>${s.runs}</td>
    <td${style}>${s.rbi}</td>
    <td${style}>${s.homeRuns}</td>
    <td${style}>${fmt(s.avg)}</td>
  </tr>`;
}

function kboVsOpponentCard(title, batters) {
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

// Last 5/10/20 views: an actual per-game list per batter (Date, Opp, AB, H,
// R, RBI, HR), not a combined totals row -- one small table per batter,
// mirroring the Excel workbook's Game Log tab layout, including its exact
// row-coloring rule (see kboGameColor).
function kboGameRow(g) {
  const bg = kboGameColor(g);
  return `<tr style="background-color:${bg};">
    <td>${g.date || '—'}</td>
    <td>${g.opp}</td>
    <td>${g.ab}</td>
    <td>${g.h}</td>
    <td>${g.r}</td>
    <td>${g.rbi}</td>
    <td>${g.hr}</td>
  </tr>`;
}

// Chart points for one batter's Last 5/10/20 game log -- bars are the same
// H+R+RBI total kboGameColor already bands into 4 tiers for the table rows,
// so the chart's bar colors use those exact same real hex values (inline
// `color`, not a fixed hit/miss palette) rather than introducing a second,
// inconsistent color language for the same underlying number.
function kboGameChartPoints(games) {
  const ordered = [...games].reverse(); // recent_window() returns most-recent-first -> oldest-to-newest for the chart
  return ordered.map((g) => {
    const total = g.h + g.r + g.rbi;
    return {
      value: total,
      color: kboGameColor(g),
      tooltipHtml: `
        <div class="prop-tooltip-date">${g.date || '—'}</div>
        <div class="prop-tooltip-score">vs ${g.opp}</div>
        <div class="prop-tooltip-stat"><span>AB / H / R / RBI / HR</span><strong>${g.ab}/${g.h}/${g.r}/${g.rbi}/${g.hr}</strong></div>
      `,
    };
  });
}

// batter.id -> chart points, populated while building the HTML string
// (kboBatterGameLogBlock) and read back after innerHTML assignment
// (renderKboMatchup) to wire up hover -- same pattern as mlbBatterContext,
// needed because a plain HTML string can't carry live event listeners.
const kboChartPointsByBatter = new Map();

function kboBatterGameLogBlock(b) {
  const s = b.stats[state.kboView];
  // Same watchlist-id namespacing approach as MLB's batter cards
  // (mlb-player-{id}) -- kbo-player-{id} keeps KBO batters, MLB batters,
  // and regular prop items from ever colliding in the shared
  // state.watchlist Set even if two different sports' numeric player ids
  // happened to match.
  const watchId = `kbo-player-${b.id}`;
  const isWatched = state.watchlist.has(watchId);
  const headHtml = `<div class="kbo-batter-gamelog-head">
    <button class="star-btn kbo-star-btn ${isWatched ? 'active' : ''}" data-star="${watchId}" title="Toggle watchlist">${starIcon(isWatched)}</button>
    <h4>${b.fullName}</h4>
  </div>`;
  if (!s || !s.games.length) {
    return `<div class="kbo-batter-gamelog">${headHtml}<p class="mlb-subtitle">No games in this window.</p></div>`;
  }
  const points = kboGameChartPoints(s.games);
  kboChartPointsByBatter.set(String(b.id), points);
  return `<div class="kbo-batter-gamelog" data-kbo-chart="${b.id}">
    ${headHtml}
    <div class="prop-chart-wrap">${buildBarChartSvg(points, { height: 140 })}<div class="prop-chart-tooltip" hidden></div></div>
    <div class="mlb-table-wrap">
      <table class="mlb-table">
        <thead><tr><th>Date</th><th>Opp</th><th>AB</th><th>H</th><th>R</th><th>RBI</th><th>HR</th></tr></thead>
        <tbody>${s.games.map(kboGameRow).join('')}</tbody>
      </table>
    </div>
  </div>`;
}

function kboGameLogCard(title, batters) {
  if (!batters || batters.length === 0) {
    return `<div class="mlb-pitcher-card"><h3>${title}</h3><p class="mlb-subtitle">No data found for this view.</p></div>`;
  }
  return `<div class="mlb-pitcher-card">
    <h3>${title}</h3>
    ${batters.map(kboBatterGameLogBlock).join('')}
  </div>`;
}

function kboTeamCard(title, batters) {
  return state.kboView === 'vsOpponent'
    ? kboVsOpponentCard(title, batters)
    : kboGameLogCard(title, batters);
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
  kboChartPointsByBatter.clear();
  el.kboMatchupContent.innerHTML =
    kboTeamCard(`${awayLabel} batters vs. ${homeLabel}`, data.awayBattersVsHome) +
    kboTeamCard(`${homeLabel} batters vs. ${awayLabel}`, data.homeBattersVsAway);
  el.kboMatchupContent.querySelectorAll('[data-kbo-chart]').forEach((wrap) => {
    const points = kboChartPointsByBatter.get(wrap.dataset.kboChart);
    if (points) bindBarChartTooltip(wrap, points);
  });
  el.kboMatchupContent.querySelectorAll('.star-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWatchlist(btn.dataset.star);
      const isWatched = state.watchlist.has(btn.dataset.star);
      btn.classList.toggle('active', isWatched);
      btn.innerHTML = starIcon(isWatched);
    });
  });
}

async function loadKboMatchup() {
  const game = state.kboGames.find((g) => gameKey(g) === state.kboSelectedGameKey);
  if (!game) return;
  el.kboMatchupContent.innerHTML = loadingOverlay("Loading matchup data… (mykbostats.com is slower than MLB's API, this can take a few seconds)");
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
    el.noVigGrid.innerHTML = loadingOverlay('Scanning all sports for the best no-vig edges…');
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
  loadMiniForms(state.noVigItems, el.noVigGrid);
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
el.mlbDateSelect.addEventListener('change', () => {
  state.mlbSelectedDate = el.mlbDateSelect.value;
  renderMlbGameSelectForDate();
  loadMlbMatchup();
});
el.viewTabKbo.addEventListener('click', () => setView('kbo'));
el.kboGameSelect.addEventListener('change', () => {
  state.kboSelectedGameKey = el.kboGameSelect.value;
  loadKboMatchup();
});
el.kboDateSelect.addEventListener('change', () => {
  state.kboSelectedDate = el.kboDateSelect.value;
  renderKboGameSelectForDate();
  loadKboMatchup();
});
el.kboViewSelect.addEventListener('change', () => {
  state.kboView = el.kboViewSelect.value;
  renderKboMatchup();
});

render();
// Once the initial Markets fetch resolves (success or failure -- either
// way the app has something to show), fade the splash out and remove it
// from the DOM so it can't intercept clicks or linger behind on repeat
// theme/layout changes.
loadItems().finally(() => {
  const splash = document.getElementById('app-splash');
  if (!splash) return;
  splash.classList.add('app-splash-hide');
  setTimeout(() => splash.remove(), 550);
});
