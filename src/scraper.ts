import * as dotenv from "dotenv";
import { chromium } from "playwright";

dotenv.config();

interface CarResult {
  vendor: string;
  carType: string;
  price: string;
  pricePerDay: string;
  features: string[];
}

interface PreflightResult {
  url: string;
  status: number;
}

const COSTCO_RENTAL_CAR_URLS = [
  "https://www.costcotravel.com/Rental-Cars",
  "https://www.costcotravel.com/rental-cars",
  "https://www.costcotravel.com/Rental-Cars/",
];

const COSTCO_HOMEPAGE_URL = "https://www.costcotravel.com";

function getEnv(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(
      `Missing required environment variable: ${key}. Please set it in your .env file (see .env.example).`
    );
  }
  return value;
}

async function scrape(): Promise<void> {
  const pickupLocation = getEnv("PICKUP_LOCATION");
  const pickupDate = getEnv("PICKUP_DATE");
  const pickupTime = getEnv("PICKUP_TIME");
  const dropoffDate = getEnv("DROPOFF_DATE");
  const dropoffTime = getEnv("DROPOFF_TIME");
  const headless = getEnv("HEADLESS", "true") !== "false";
  const strictPreflight = getEnv("PREFLIGHT_STRICT", "false") === "true";

  console.log("=== Costco Travel Rental Car Price Scraper ===");
  console.log(`Location : ${pickupLocation}`);
  console.log(`Pickup   : ${pickupDate} ${pickupTime}`);
  console.log(`Dropoff  : ${dropoffDate} ${dropoffTime}`);
  console.log(`Headless : ${headless}`);
  console.log("==============================================\n");

  try {
    const preflight = await preflightConnectivity();
    console.log(
      `Preflight OK: ${preflight.url} responded with HTTP ${preflight.status}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (strictPreflight) {
      throw error;
    }
    console.warn(`Preflight warning: ${message}`);
    console.warn("Continuing anyway because PREFLIGHT_STRICT is false.");
  }

  const proxyServer = process.env.PROXY_SERVER?.trim();
  const proxy = proxyServer
    ? {
        server: proxyServer,
        username: process.env.PROXY_USERNAME?.trim() || undefined,
        password: process.env.PROXY_PASSWORD?.trim() || undefined,
      }
    : undefined;

  if (proxy) {
    console.log(`Using proxy: ${proxy.server}`);
  }

  const browser = await chromium.launch({
    headless,
    proxy,
    // Costco occasionally fails with ERR_HTTP2_PROTOCOL_ERROR in Playwright/Chromium.
    // Disabling HTTP/2 makes navigation more reliable.
    args: ["--disable-http2"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
      DNT: "1",
      "Upgrade-Insecure-Requests": "1",
    },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
    });
  });

  try {
    console.log("Navigating to Costco Travel...");
    const page = await gotoCostcoRentalCars(context);

    // Fill pickup location
    console.log("Filling in search form...");
    const locationInput = page.locator(
      'input[placeholder*="ickup"], input[id*="pickup"], input[name*="pickup"], input[aria-label*="ickup"]'
    ).first();
    await locationInput.waitFor({ state: "visible", timeout: 15000 });
    await locationInput.fill(pickupLocation);

    // Wait for autocomplete and select first suggestion
    const suggestion = page.locator(
      '[class*="autocomplete"] li, [class*="suggestion"] li, [role="option"]'
    ).first();
    try {
      await suggestion.waitFor({ state: "visible", timeout: 5000 });
      await suggestion.click();
    } catch {
      // No autocomplete appeared — just continue
    }

    // Fill pickup date
    const pickupDateInput = page.locator(
      'input[placeholder*="ickup"][type="text"], input[id*="pickupDate"], input[name*="pickupDate"]'
    ).first();
    await pickupDateInput.fill(pickupDate);

    // Fill pickup time
    const pickupTimeSelect = page.locator(
      'select[id*="pickupTime"], select[name*="pickupTime"]'
    ).first();
    try {
      await pickupTimeSelect.waitFor({ state: "visible", timeout: 3000 });
      await pickupTimeSelect.selectOption({ label: pickupTime });
    } catch {
      const pickupTimeInput = page.locator(
        'input[id*="pickupTime"], input[name*="pickupTime"]'
      ).first();
      await pickupTimeInput.fill(pickupTime);
    }

    // Fill dropoff date
    const dropoffDateInput = page.locator(
      'input[placeholder*="ropoff"][type="text"], input[id*="dropoffDate"], input[name*="dropoffDate"]'
    ).first();
    await dropoffDateInput.fill(dropoffDate);

    // Fill dropoff time
    const dropoffTimeSelect = page.locator(
      'select[id*="dropoffTime"], select[name*="dropoffTime"]'
    ).first();
    try {
      await dropoffTimeSelect.waitFor({ state: "visible", timeout: 3000 });
      await dropoffTimeSelect.selectOption({ label: dropoffTime });
    } catch {
      const dropoffTimeInput = page.locator(
        'input[id*="dropoffTime"], input[name*="dropoffTime"]'
      ).first();
      await dropoffTimeInput.fill(dropoffTime);
    }

    // Submit the search
    console.log("Submitting search...");
    const searchButton = page.locator(
      'button[type="submit"], button:has-text("Search"), input[type="submit"]'
    ).first();
    await searchButton.click();

    // Wait for results page to load
    console.log("Waiting for results...");
    await page.waitForLoadState("networkidle", { timeout: 60000 });

    // Extract results
    const results = await extractResults(page);

    if (results.length === 0) {
      console.log(
        "No results found. The website layout may have changed — try running with HEADLESS=false to debug."
      );
    } else {
      printResults(results);
    }
  } finally {
    await browser.close();
  }
}

async function gotoCostcoRentalCars(
  context: import("playwright").BrowserContext
): Promise<import("playwright").Page> {
  const waitStrategies: Array<"commit" | "domcontentloaded" | "load"> = [
    "commit",
    "domcontentloaded",
    "load",
  ];
  const attemptCount = 2;
  const pageTimeout = 45000;

  let lastError: unknown;

  for (const url of COSTCO_RENTAL_CAR_URLS) {
    for (const waitUntil of waitStrategies) {
      for (let attempt = 1; attempt <= attemptCount; attempt++) {
        const page = await context.newPage();
        try {
          console.log(
            `Trying ${url} (waitUntil=${waitUntil}, attempt=${attempt}/${attemptCount})...`
          );
          await page.goto(url, {
            waitUntil,
            timeout: pageTimeout,
          });
          return page;
        } catch (error) {
          lastError = error;
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`Navigation attempt failed: ${message}`);
          await page.close().catch(() => undefined);
        }
      }
    }
  }

  for (let attempt = 1; attempt <= attemptCount; attempt++) {
    const page = await context.newPage();
    try {
      console.log(`Trying homepage fallback (attempt=${attempt}/${attemptCount})...`);
      await page.goto(COSTCO_HOMEPAGE_URL, {
        waitUntil: "domcontentloaded",
        timeout: pageTimeout,
      });
      await page.goto(COSTCO_RENTAL_CAR_URLS[0], {
        waitUntil: "commit",
        timeout: pageTimeout,
      });
      return page;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Homepage fallback failed: ${message}`);
      await page.close().catch(() => undefined);
    }
  }

  throw new Error(
    `Unable to open Costco Travel rental cars page after multiple attempts. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

async function preflightConnectivity(): Promise<PreflightResult> {
  const timeoutMs = 12000;
  const targets = [COSTCO_HOMEPAGE_URL, COSTCO_RENTAL_CAR_URLS[0]];

  for (const target of targets) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(target, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        },
      });
      clearTimeout(timeoutId);

      if (response.ok || response.status === 403 || response.status === 429) {
        return {
          url: target,
          status: response.status,
        };
      }
    } catch {
      // Continue trying other targets.
    }
  }

  throw new Error(
    "Costco Travel is not reachable from this environment. This often happens from cloud/devcontainer IPs. Try running locally or set PROXY_SERVER (and optional PROXY_USERNAME / PROXY_PASSWORD)."
  );
}

async function extractResults(page: import("playwright").Page): Promise<CarResult[]> {
  // Try multiple common result card selectors Costco Travel has used
  const cardSelectors = [
    '[class*="car-result"]',
    '[class*="vehicle-card"]',
    '[class*="rental-result"]',
    '[data-testid*="car"]',
    '[class*="result-item"]',
  ];

  for (const selector of cardSelectors) {
    const cards = await page.locator(selector).all();
    if (cards.length > 0) {
      return await Promise.all(
        cards.map(async (card) => {
          const vendor = await card
            .locator('[class*="vendor"], [class*="supplier"], [alt]')
            .first()
            .getAttribute("alt")
            .catch(() => "")
            ?? await card.locator('[class*="vendor"], [class*="supplier"]').first().textContent().catch(() => "Unknown");

          const carType = await card
            .locator('[class*="car-type"], [class*="vehicle-name"], [class*="model"]')
            .first()
            .textContent()
            .catch(() => "Unknown");

          const price = await card
            .locator('[class*="total-price"], [class*="price"]:not([class*="per-day"])')
            .first()
            .textContent()
            .catch(() => "N/A");

          const pricePerDay = await card
            .locator('[class*="per-day"], [class*="daily-rate"]')
            .first()
            .textContent()
            .catch(() => "N/A");

          const featureEls = await card
            .locator('[class*="feature"], [class*="amenity"], li')
            .all();
          const features: string[] = [];
          for (const el of featureEls) {
            const text = (await el.textContent().catch(() => ""))?.trim();
            if (text) features.push(text);
          }

          return {
            vendor: (vendor ?? "Unknown").trim(),
            carType: (carType ?? "Unknown").trim(),
            price: (price ?? "N/A").trim(),
            pricePerDay: (pricePerDay ?? "N/A").trim(),
            features: features.slice(0, 5),
          };
        })
      );
    }
  }

  // Fallback: try to find any price elements and report raw text
  const priceEls = await page.locator('[class*="price"]').all();
  if (priceEls.length > 0) {
    const fallback: CarResult[] = [];
    for (const el of priceEls.slice(0, 20)) {
      const text = (await el.textContent().catch(() => ""))?.trim();
      if (text && /\$[\d,]+/.test(text)) {
        fallback.push({
          vendor: "Unknown",
          carType: "Unknown",
          price: text,
          pricePerDay: "N/A",
          features: [],
        });
      }
    }
    return fallback;
  }

  return [];
}

function printResults(results: CarResult[]): void {
  console.log(`\nFound ${results.length} result(s):\n`);
  console.log(
    "─".repeat(70)
  );

  // Sort by price ascending (extract numeric value)
  const sorted = [...results].sort((a, b) => {
    const extractNumericPrice = (s: string) => parseFloat(s.replace(/[^0-9.]/g, "")) || Infinity;
    return extractNumericPrice(a.price) - extractNumericPrice(b.price);
  });

  sorted.forEach((r, i) => {
    console.log(`#${i + 1}  ${r.vendor} — ${r.carType}`);
    console.log(`    Total: ${r.price}  (${r.pricePerDay}/day)`);
    if (r.features.length > 0) {
      console.log(`    Features: ${r.features.join(" | ")}`);
    }
    console.log("─".repeat(70));
  });
}

scrape().catch((err: unknown) => {
  console.error("Scraper failed:", err);
  process.exit(1);
});
