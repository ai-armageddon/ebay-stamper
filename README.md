# eBay Stamper

A Node.js app that finds potentially underpriced USPS stamp listings on eBay by comparing live listing costs against current USPS stamp rates, then scoring each listing for profit potential and seller trust.

## What This App Does

- Fetches current USPS domestic and global Forever rates (with cache + fallback behavior).
- Pulls eBay listings from the Browse API (with token refresh and pagination support).
- Infers stamp type/count from listing titles.
- Computes deal math (spread, discount, per-stamp economics, value multiplier).
- Computes seller trust signals and an overall opportunity score.
- Exposes JSON APIs and a browser dashboard with Card, Bar, and List views.

## Key Features

- eBay Browse API integration with OAuth client-credentials flow.
- Automatic retry with fresh token after 401 responses.
- Listing cache to reduce repeated eBay API calls.
- Cache-first refreshes with periodic background recrawls.
- Manual "recrawl deeper" flow to gradually widen crawl depth.
- USPS rate scraping with 24-hour disk cache and JSON fallback.
- Optional mock listing fallback for development/demo continuity.
- Rate history pipeline (announcement scraping + daily timeline materialization).
- Filters for stamp type, condition, minimum discount, minimum trust, trust tier, and profitability.

## Tech Stack

- Runtime: Node.js (CommonJS)
- HTTP server: built-in `http`
- HTTP client: `axios`
- Config: `dotenv`
- Tests: Node built-in test runner (`node --test`)
- Frontend: vanilla HTML/CSS/JS

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Create local environment file:

```bash
cp .env.example .env
```

3. Add eBay credentials in `.env` (minimum: `EBAY_APP_ID` and `EBAY_CERT_ID`).

4. Start the app:

```bash
npm run dev
```

5. Open:

```text
http://localhost:3000
```

## Available Scripts

- `npm run dev` - start server locally.
- `npm start` - same as `dev`.
- `npm test` - run automated tests in `test/*.test.js`.
- `npm run build:rate-history` - rebuild `data/usps-rate-history.json`.

## Environment Variables

Configured in `.env` (template in `.env.example`):

- `PORT` (optional): server port. Default `3000`.
- `EBAY_APP_ID` (required for live eBay): eBay app/client ID.
- `EBAY_CERT_ID` (required for live eBay): eBay cert/client secret.
- `EBAY_TOKEN` (optional): pre-fetched OAuth token; used until invalid/expired.
- `EBAY_ENV` (optional): `PRODUCTION` or `SANDBOX`.
- `EBAY_API_BASE_URL` (optional): overrides API base URL.
- `EBAY_TOKEN_URL` (optional): overrides token endpoint URL.
- `EBAY_SCOPES` (optional): OAuth scopes; defaults to `https://api.ebay.com/oauth/api_scope`.
- `LISTINGS_CACHE_MS` (optional): in-memory listing cache TTL. Default `90000`.
- `EBAY_MAX_RESULTS` (optional): default listing cap per request. Default `150`.
- `EBAY_MAX_PAGES` (optional): default page cap for API pagination. Default `5`.

## API Reference

### `GET /api/deals`

Builds an arbitrage feed from USPS rates + eBay listings.

Query params:

- `q` (string): search query. Default `usps forever stamps`.
- `sort`: `best | discount | price | trust | recent`.
- `stampType`: `all | domestic | global`.
- `condition`: `all | new | used`.
- `minDiscount` (number): minimum discount percent.
- `minTrust` (number): minimum trust score.
- `trustTier`: `all | high | medium | low`.
- `profitableOnly`: `true | false`.
- `useMock`: `true | false`.
- `forceEbayRefresh`: `true | false`.
- `recrawl`: `true | false` (force a deeper live crawl now).
- `maxResults` (number): clamped by server bounds.
- `maxPages` (number): clamped by server bounds.

Response shape (high-level):

- `generatedAt`
- `rates`, `ratesSource`
- `listingsSource`, `listingsFetchMode`, `listingsCacheAgeMs`
- `crawlStats` (`fetchedCount`, `totalMatchesEstimate`, `apiCallsUsed`, etc.)
- `summary` (`profitableCount`, `eliteCount`, `avgDiscount`, `avgTrust`, best-deal fields)
- `deals[]` (fully computed per-listing metrics)

Example:

```bash
curl "http://localhost:3000/api/deals?sort=best&minTrust=70&profitableOnly=true&maxResults=150"
```

### `GET /api/rates/history`

Returns USPS daily rate history payload.

Query params:

- `from` (`YYYY-MM-DD`, optional)
- `to` (`YYYY-MM-DD`, optional)

Response includes:

- `generatedAt`, `historyStartDate`, `historyEndDate`
- `rateChanges[]`
- `dailyRates[]` (filtered by `from`/`to` if provided)

Example:

```bash
curl "http://localhost:3000/api/rates/history?from=2025-01-01&to=2026-01-31"
```

## Scoring and Deal Logic

Core calculations happen in `/Users/ai_armageddon/Desktop/Portfolio/eBay-Stamper/src/arbitrage.js`.

Per listing, the app derives:

- `stampType`: inferred from title (`global`/`international` => global, else domestic).
- `stampCount`: inferred from quantity patterns (`20 ct`, `booklet`, `coil`, grouped quantities, etc.).
- `marketValue`: `uspsRate * stampCount`.
- `totalCost`: listing price + shipping.
- `savings` / `underpricedDollars`: `marketValue - totalCost`.
- `discountPct` / `underpricedPct`: percent spread vs USPS market value.
- `costPerStamp` and `perStampDiscountPct`.

Trust model combines:

- seller feedback percentage
- seller feedback volume
- top-rated seller status

Opportunity score blends:

- discount strength
- absolute savings
- trust score
- recency decay

Deal tiers:

- `elite`
- `strong`
- `watch`
- `pass`

Buy signals:

- `BUY NOW`, `STRONG BUY`, `WATCH`, `PASS`

## Data Sources and Caching

### USPS Rates

Runtime path: `/Users/ai_armageddon/Desktop/Portfolio/eBay-Stamper/src/usps-rates.js`

Behavior:

1. Use fresh disk cache in `data/usps-rates-cache.json` if under 24h old.
2. Else scrape USPS pages for domestic/global Forever rates.
3. On scrape failure, fall back to `data/usps-rates-fallback.json`.

Note: `data/usps-rates-cache.json` is gitignored.

### eBay Listings

Runtime path: `/Users/ai_armageddon/Desktop/Portfolio/eBay-Stamper/src/ebay-client.js`

Behavior:

1. Check in-memory cache keyed by query/results/pages.
2. Fetch OAuth token (use `EBAY_TOKEN` first, or mint from app/cert credentials).
3. Query Browse API with pagination and dedupe by item ID.
4. On live-fetch failure, optionally return mock data if `useMock=true`.

## USPS Rate History Pipeline

Paths:

- Builder script: `/Users/ai_armageddon/Desktop/Portfolio/eBay-Stamper/scripts/build-rate-history.js`
- Logic: `/Users/ai_armageddon/Desktop/Portfolio/eBay-Stamper/src/usps-rate-history.js`
- Output: `/Users/ai_armageddon/Desktop/Portfolio/eBay-Stamper/data/usps-rate-history.json`

Pipeline combines:

- curated USPS announcement URLs
- USPS news feed discovery
- text parsing for effective dates and planned rates
- manual fallback change points
- optional synthetic “today” change if live rates differ
- daily row materialization from baseline start date

## Frontend Dashboard

Static UI served from `/Users/ai_armageddon/Desktop/Portfolio/eBay-Stamper/public`.

Views:

- Cards: listing cards with trust + economics highlights
- Bars: spread-focused bar visualization with threshold filter
- List: sortable table for quick scanning/export-style analysis

UI also includes:

- localStorage persistence of filter/view state
- optional auto-refresh loop
- force-refresh toggle to bypass listing cache

## Project Structure

```text
app.js                         HTTP server and route handlers
public/                        Dashboard frontend assets
src/arbitrage.js               Deal math, scoring, filters, sorting, summary
src/ebay-client.js             eBay OAuth + Browse API + listing cache
src/usps-rates.js              USPS scraping + cache/fallback rate loader
src/usps-rate-history.js       USPS rate-history builder and refresh logic
src/mock-listings.js           Mock listing fallback dataset
scripts/build-rate-history.js  CLI builder for history JSON
data/                          Cached and generated USPS data files
test/                          Automated tests (API, scoring, history parsing)
test-ebay-api.js               Manual eBay token/search smoke test
```

## Testing

Run automated tests:

```bash
npm test
```

Included test coverage validates:

- stamp type/count inference
- deal math and filter/sort behavior
- API handler response structure
- USPS announcement parsing and history timeline logic

Manual live API smoke test (requires valid eBay credentials):

```bash
node test-ebay-api.js
```

## Troubleshooting

### “Missing EBAY_APP_ID or EBAY_CERT_ID in .env”

- Add valid credentials to `.env`.
- Or use `useMock=true` in `/api/deals` for non-live development.

### eBay 401 Unauthorized

- Your `EBAY_TOKEN` is likely expired.
- Provide a fresh token or remove `EBAY_TOKEN` so token minting uses app/cert credentials.

### USPS scrape failures

- The app falls back to `data/usps-rates-fallback.json`.
- Ensure fallback file exists and has valid `rates` payload.

### Unexpectedly stale listings

- Disable cache for a request using `forceEbayRefresh=true`.
- Reduce `LISTINGS_CACHE_MS` in `.env`.

### Large API cost / too many eBay calls

- Lower `maxResults` and `maxPages` query params.
- Tune defaults with `EBAY_MAX_RESULTS` and `EBAY_MAX_PAGES`.

## Security Notes

- Do not commit `.env`.
- API tokens/secrets should stay in environment variables.
- Static file serving includes path normalization and parent-directory checks.
- Frontend links are sanitized to `http/https` before rendering.

## License

MIT
