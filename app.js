import { LEAGUES, MARKET_TYPES, fetchLiveItems, formatAmerican } from './odds.js';
import { SAMPLE_ITEMS } from './sample-odds.js';

const WATCHLIST_KEY = 'vantage.watchlist';
const THEME_KEY = 'vantage.theme';

const state = {
  search: '',
  marketType: 'All',
  league: LEAGUES[0].id,
  sort: 'edge',
  watchlistOnly: false,
  watchlist: new Set(JSON.parse(localStorage.getItem(WATCHLIST_KEY) || '[]')),
  items: [],
  usingFallback: false,
  loading: true,
};

const el = {
  grid: document.getElementById('card-grid'),
  empty: document.getElementById('empty-state'),
  stats: document.getElementById('stats-row'),
  chips: document.getElementById('category-chips'),
  sort: document.getElementById('sort-select'),
  leagueSelect: document.getElementById('league-select'),
  search: document.getElementById('search-input'),
  watchlistToggle: document.getElementById('watchlist-toggle'),
  watchlistCount: document.getElementById('watchlist-count'),
  themeToggle: document.getElementById('theme-toggle'),
  modalBackdrop: document.getElementById('modal-backdrop'),
  modalContent: document.getElementById('modal-content'),
  statusBanner: document.getElementById('status-banner'),
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
    const items = await fetchLiveItems(state.league);
    state.items = items;
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

function getFilteredItems() {
  let items = state.items.filter((item) => {
    if (state.marketType !== 'All' && item.marketType !== state.marketType) return false;
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
    el.leagueSelect.innerHTML = LEAGUES.map((l) => `<option value="${l.id}">${l.label}</option>`).join('');
    el.leagueSelect.dataset.built = 'true';
    el.leagueSelect.addEventListener('change', () => {
      state.league = el.leagueSelect.value;
      loadItems();
    });
  }
  el.leagueSelect.value = state.league;
}

function renderCard(item) {
  const isWatched = state.watchlist.has(item.id);
  const arrow = movementArrow(item.openBookOdds, item.bestPrice);
  return `<article class="item-card" data-id="${item.id}">
    <button class="star-btn ${isWatched ? 'active' : ''}" data-star="${item.id}" title="Toggle watchlist">${starIcon(isWatched)}</button>
    <div class="card-top">
      <span class="card-category">${item.league} · ${item.marketType}</span>
      ${item.isOutlier ? '<span class="outlier-badge">Value edge</span>' : ''}
    </div>
    <div class="item-name">${item.name}</div>
    <div class="rating-row">${formatKickoff(item.startsAt)}</div>
    <div class="movement-row">${item.openBookOdds ? `Opened ${formatAmerican(item.openBookOdds)} → Now ${formatAmerican(item.bestPrice)} ${arrow}` : ''}</div>
    <div class="price-row">
      <span class="best-price">${formatAmerican(item.bestPrice)}</span>
      ${item.fairOdds ? `<span class="market-price">${formatAmerican(item.fairOdds)}</span>` : ''}
      ${item.edgePct != null ? `<span class="savings-pct">${item.edgePct >= 0 ? '+' : ''}${item.edgePct}%</span>` : ''}
    </div>
    <div class="vendor-row"><span>Best at</span><span class="vendor-name">${item.bestVendor}</span></div>
  </article>`;
}

function renderGrid() {
  const items = getFilteredItems();
  el.empty.hidden = items.length !== 0 || state.loading;
  el.grid.innerHTML = state.loading ? '<p class="empty-state">Loading live odds…</p>' : items.map(renderCard).join('');
  el.grid.querySelectorAll('.star-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWatchlist(btn.dataset.star);
    });
  });
  el.grid.querySelectorAll('.item-card').forEach((card) => {
    card.addEventListener('click', () => openModal(card.dataset.id));
  });
}

function openModal(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  const isWatched = state.watchlist.has(item.id);
  const rows = item.bookmakers
    .map(
      (b, i) => `<tr class="${i === 0 ? 'best-row' : ''}">
        <td class="vendor-name">${b.label}</td>
        <td class="price-cell">${formatAmerican(b.american)}</td>
        <td>${b.deeplink ? `<a class="stock-tag in" href="${b.deeplink}" target="_blank" rel="noopener">Open ↗</a>` : '<span class="stock-tag out">No link</span>'}</td>
      </tr>`
    )
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
    <table class="vendor-table">
      <thead><tr><th>Sportsbook</th><th>Odds</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
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
}

function closeModal() {
  el.modalBackdrop.hidden = true;
  el.modalContent.innerHTML = '';
}

function render() {
  renderStats();
  renderChips();
  renderLeagueSelect();
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

render();
loadItems();
