// Mock catalog data for Vantage. Prices are illustrative sample data, not live feeds.

const VENDOR_NAMES = ['Northgate', 'Corestore', 'Pinehill Retail', 'Lumen Mart', 'Rivergate', 'Basecamp Supply', 'Anchor & Co'];

function makeHistory(base, points, volatility) {
  const history = [];
  let value = base * (1 + volatility);
  for (let i = 0; i < points; i++) {
    const drift = (Math.sin(i * 0.7 + base) * volatility * base) / 3;
    value = Math.max(base * 0.7, value + drift - volatility * base * 0.08);
    history.push(Math.round(value * 100) / 100);
  }
  history[history.length - 1] = base;
  return history;
}

function makeVendors(base, count, spreadPct) {
  const shuffled = [...VENDOR_NAMES].sort(() => 0.5 - Math.random()).slice(0, count);
  return shuffled
    .map((name, i) => {
      const jitter = (i === 0 ? -1 : 1) * Math.random() * spreadPct;
      const price = Math.round(base * (1 + jitter) * 100) / 100;
      return {
        vendor: name,
        price,
        inStock: Math.random() > 0.12,
      };
    })
    .sort((a, b) => a.price - b.price);
}

function buildItem(id, name, category, base, opts = {}) {
  const vendorCount = opts.vendorCount || 4;
  const spread = opts.spread ?? 0.22;
  const vendors = makeVendors(base, vendorCount, spread);
  const marketAvg = Math.round((vendors.reduce((s, v) => s + v.price, 0) / vendors.length) * 100) / 100;
  const best = vendors[0];
  const savingsPct = Math.round(((marketAvg - best.price) / marketAvg) * 1000) / 10;
  const history = makeHistory(best.price, 14, 0.15);
  return {
    id,
    name,
    category,
    rating: Math.round((3.6 + Math.random() * 1.3) * 10) / 10,
    reviewCount: Math.floor(80 + Math.random() * 3200),
    vendors,
    marketAvg,
    bestPrice: best.price,
    bestVendor: best.vendor,
    savingsPct,
    history,
    isOutlier: savingsPct >= 18,
  };
}

const CATALOG_SEED = [
  ['Wireless ANC Headphones', 'Electronics', 179],
  ['4K Streaming Stick', 'Electronics', 39],
  ['Mechanical Keyboard', 'Electronics', 94],
  ['Robot Vacuum', 'Home & Kitchen', 249],
  ['Espresso Machine', 'Home & Kitchen', 189],
  ['Cast Iron Skillet Set', 'Home & Kitchen', 62],
  ['Weekender Duffel Bag', 'Travel', 76],
  ['Noise-Isolating Earbuds', 'Travel', 58],
  ['Carry-On Hardshell', 'Travel', 134],
  ['Project Management Suite (annual)', 'Software', 96],
  ['Cloud Backup Plan (annual)', 'Software', 71],
  ['Design Tool Pro (annual)', 'Software', 129],
  ['Insulated Camp Cooler', 'Outdoor', 210],
  ['3-Season Tent', 'Outdoor', 245],
  ['Trail Running Shoes', 'Outdoor', 118],
  ['Standing Desk Converter', 'Home & Kitchen', 165],
  ['Smart Thermostat', 'Home & Kitchen', 142],
  ['Portable SSD 2TB', 'Electronics', 158],
  ['Fitness Tracker Band', 'Electronics', 89],
  ['Packing Cube Set', 'Travel', 34],
  ['VPN Subscription (annual)', 'Software', 54],
  ['Hydration Vest', 'Outdoor', 88],
];

export const CATEGORIES = ['All', 'Electronics', 'Home & Kitchen', 'Travel', 'Software', 'Outdoor'];

export const CATALOG = CATALOG_SEED.map(([name, category, base], i) =>
  buildItem(i + 1, name, category, base, { vendorCount: 3 + (i % 3), spread: 0.14 + (i % 5) * 0.035 })
);
