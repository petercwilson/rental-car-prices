# Rental Car Price Scraper

A Node.js TypeScript application that scrapes rental car prices from [Costco Travel](https://www.costcotravel.com/Rental-Cars) for a specific pickup location and date range.

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- npm

## Setup

1. Clone this repository.
2. Run `npm install` to install dependencies.
3. Install the Playwright browser and its system dependencies:
   ```bash
   npx playwright install --with-deps chromium
   ```
4. Copy `.env.example` to `.env` and fill in your search parameters:
   ```bash
   cp .env.example .env
   ```

## Configuration

Edit `.env` with your desired search:

| Variable          | Description                                  | Example          |
|-------------------|----------------------------------------------|------------------|
| `PICKUP_LOCATION` | Airport code or city name                    | `LAX`            |
| `PICKUP_DATE`     | Pickup date (`MM/DD/YYYY`)                   | `06/01/2026`     |
| `PICKUP_TIME`     | Pickup time (12-hour format)                 | `10:00 AM`       |
| `DROPOFF_DATE`    | Dropoff date (`MM/DD/YYYY`)                  | `06/07/2026`     |
| `DROPOFF_TIME`    | Dropoff time (12-hour format)                | `10:00 AM`       |
| `HEADLESS`        | `true` to run invisibly, `false` to see the browser | `true`    |
| `PREFLIGHT_STRICT`| `true` to abort when connectivity precheck fails     | `false`   |
| `PROXY_SERVER`    | Optional proxy URL when Costco blocks your IP | `http://host:port` |
| `PROXY_USERNAME`  | Optional proxy username                        | `myuser`         |
| `PROXY_PASSWORD`  | Optional proxy password                        | `mypassword`     |

## Usage

```bash
npm run scrape
```

Results are printed to the console, sorted by total price (cheapest first).

### GitHub Actions

A `scrape` workflow is included in `.github/workflows/scrape.yml`. Trigger it manually from the **Actions** tab in GitHub by selecting **Scrape Rental Car Prices** and filling in the search parameters. The workflow automatically installs Chromium and its system dependencies, so no local setup is required.

### Debugging

Set `HEADLESS=false` in your `.env` to watch the browser interact with the page in real time — useful when no results are returned.

If you are running in a cloud/devcontainer environment, Costco Travel may timeout or block the request from that IP range. The scraper performs a connectivity precheck and logs the result. By default that precheck is warning-only; set `PREFLIGHT_STRICT=true` if you want it to fail fast instead. If Costco is blocked from your environment, run locally or configure `PROXY_SERVER`.

### Building (optional)

```bash
npm run build   # compiles TypeScript to dist/
npm start       # runs the compiled output
```

## Legal Disclaimer

Please review the [Terms of Service](https://www.costco.com/terms-and-conditions-of-use.html) of Costco Travel before using this scraper. This tool is intended for personal use only.