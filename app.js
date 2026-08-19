import { CATALOG, CATEGORIES } from './data.js';

const WATCHLIST_KEY = 'vantage.watchlist';
const THEME_KEY = 'vantage.theme';

const state = {
  search: '',
  category: 'All',
  sort: 'savings',
  watchlistOnly: false,
  watchlist: new Set(JSON.parse(localStorage.getItem(WATCHLIST_KEY) || '[]')),
};

const el = {
  grid: document.getElementById('card-grid'),
  empty: document.getElementById('empty-state'),
  stats: document.getElementById('stats-row'),
  chips: document.getElementById('category-chips'),
  sort: document.getElementById('sort-select'),
  search: document.getElementById('search-input'),
  watchlistToggle: document.getElementById('watchlist-toggle'),
  watchlistCount: document.getElementById('watchlist-count'),
  themeToggle: document.getElementById('theme-toggle'),
  modalBackdrop: document.getElementById('modal-backdrop'),
  modalContent: document.getElementById('modal-content'),
};

function sparklinePath(history, width, height, pad = 3) {
  const min = Math.min(...history);
  const max = Math.max(...history);
  const range = max - min || 1;
  const stepX = (width - pad * 2) / (history.length - 1);
  const points = history.map((v, i) => {
    const x = pad + i * stepX;
    const y = height - pad - ((v - min) / range) * (height - pad * 2);
    return [x, y];
  });
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  return { d, last: points[points.length - 1] };
}

function sparklineSvg(history, trendGood) {
  const width = 240;
  const height = 40;
  const { d, last } = sparklinePath(history, width, height);
  const color = trendGood ? 'var(--positive)' : 'var(--negative)';
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" width="100%" height="100%">
    <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3" fill="${color}" />
  </svg>`;
}

function starIcon(active) {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="${active ? 'currentColor' : 'none'}">
    <path d="M12 17.3l-6.2 3.6 1.6-7-5.4-4.7 7.1-.6L12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
  </svg>`;
}

function ratingStars(rating) {
  const full = Math.round(rating);
  return '★'.repeat(full) + '☆'.repeat(5 - full);
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

function getFilteredItems() {
  let items = CATALOG.filter((item) => {
    if (state.category !== 'All' && item.category !== state.category) return false;
    if (state.watchlistOnly && !state.watchlist.has(item.id)) return false;
    if (state.search && !item.name.toLowerCase().includes(state.search.toLowerCase())) return false;
    return true;
  });

  const sorters = {
    savings: (a, b) => b.savingsPct - a.savingsPct,
    'price-asc': (a, b) => a.bestPrice - b.bestPrice,
    'price-desc': (a, b) => b.bestPrice - a.bestPrice,
    rating: (a, b) => b.rating - a.rating,
  };
  return items.sort(sorters[state.sort]);
}

function renderStats() {
  const outliers = CATALOG.filter((i) => i.isOutlier).length;
  const avgSavings = Math.round((CATALOG.reduce((s, i) => s + i.savingsPct, 0) / CATALOG.length) * 10) / 10;
  const stats = [
    { label: 'Tracked items', value: CATALOG.length },
    { label: 'Value outliers today', value: outliers, positive: true },
    { label: 'Avg. savings vs. market', value: `${avgSavings}%`, positive: true },
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
  el.chips.innerHTML = CATEGORIES.map(
    (cat) => `<button class="category-chip ${cat === state.category ? 'active' : ''}" data-cat="${cat}">${cat}</button>`
  ).join('');
  el.chips.querySelectorAll('.category-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.category = btn.dataset.cat;
      render();
    });
  });
}

function renderCard(item) {
  const isWatched = state.watchlist.has(item.id);
  return `<article class="item-card" data-id="${item.id}">
    <button class="star-btn ${isWatched ? 'active' : ''}" data-star="${item.id}" title="Toggle watchlist">${starIcon(isWatched)}</button>
    <div class="card-top">
      <span class="card-category">${item.category}</span>
      ${item.isOutlier ? '<span class="outlier-badge">Value outlier</span>' : ''}
    </div>
    <div class="item-name">${item.name}</div>
    <div class="rating-row"><span class="rating-stars">${ratingStars(item.rating)}</span> ${item.rating} · ${item.reviewCount.toLocaleString()} reviews</div>
    <div class="sparkline-wrap">${sparklineSvg(item.history, true)}</div>
    <div class="price-row">
      <span class="best-price">$${item.bestPrice.toFixed(2)}</span>
      <span class="market-price">$${item.marketAvg.toFixed(2)}</span>
      <span class="savings-pct">-${item.savingsPct}%</span>
    </div>
    <div class="vendor-row"><span>Best at</span><span class="vendor-name">${item.bestVendor}</span></div>
  </article>`;
}

function renderGrid() {
  const items = getFilteredItems();
  el.empty.hidden = items.length !== 0;
  el.grid.innerHTML = items.map(renderCard).join('');
  el.grid.querySelectorAll('.star-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWatchlist(Number(btn.dataset.star));
    });
  });
  el.grid.querySelectorAll('.item-card').forEach((card) => {
    card.addEventListener('click', () => openModal(Number(card.dataset.id)));
  });
}

function openModal(id) {
  const item = CATALOG.find((i) => i.id === id);
  if (!item) return;
  const isWatched = state.watchlist.has(item.id);
  const rows = item.vendors
    .map(
      (v, i) => `<tr class="${i === 0 ? 'best-row' : ''}">
        <td class="vendor-name">${v.vendor}</td>
        <td class="price-cell">$${v.price.toFixed(2)}</td>
        <td><span class="stock-tag ${v.inStock ? 'in' : 'out'}">${v.inStock ? 'In stock' : 'Out of stock'}</span></td>
      </tr>`
    )
    .join('');

  el.modalContent.innerHTML = `
    <button class="modal-close" id="modal-close">&times;</button>
    <span class="card-category">${item.category}</span>
    <h2>${item.name}</h2>
    <div class="rating-row"><span class="rating-stars">${ratingStars(item.rating)}</span> ${item.rating} · ${item.reviewCount.toLocaleString()} reviews</div>
    <div class="modal-chart-wrap">${sparklineSvg(item.history, true)}</div>
    <div class="price-row">
      <span class="best-price">$${item.bestPrice.toFixed(2)}</span>
      <span class="market-price">$${item.marketAvg.toFixed(2)}</span>
      <span class="savings-pct">-${item.savingsPct}% vs. market avg.</span>
    </div>
    <table class="vendor-table">
      <thead><tr><th>Vendor</th><th>Price</th><th>Availability</th></tr></thead>
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
