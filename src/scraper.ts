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

  console.log("=== Costco Travel Rental Car Price Scraper ===");
  console.log(`Location : ${pickupLocation}`);
  console.log(`Pickup   : ${pickupDate} ${pickupTime}`);
  console.log(`Dropoff  : ${dropoffDate} ${dropoffTime}`);
  console.log(`Headless : ${headless}`);
  console.log("==============================================\n");

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  try {
    console.log("Navigating to Costco Travel...");
    await page.goto("https://www.costcotravel.com/Rental-Cars", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

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
