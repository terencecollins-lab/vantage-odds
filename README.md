# Vantage

A demo dashboard that scans a catalog of items across multiple vendors and surfaces the best current price, flagging large gaps from the market average as "value outliers."

Plain HTML/CSS/JS, no build step, no external services. All catalog, vendor, and price data in `data.js` is generated sample data for illustration — not a live feed.

## Run locally

```bash
python3 -m http.server 5173
```

Then open http://localhost:5173

## Features

- Category filters, search, and sort (best savings / price / rating)
- Per-item vendor price comparison with a stock status per vendor
- Sparkline price history on each card and in the detail view
- Watchlist (star items), persisted in `localStorage`
- Light/dark theme toggle, persisted in `localStorage`
