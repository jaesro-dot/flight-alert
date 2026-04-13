/**
 * Flight price provider via Google Flights scraping (Playwright/Chromium).
 *
 * Locale: en-US + gl=us&hl=en&curr=USD → prices always in USD.
 * Google shows round-trip prices by default; one-way queries are forced
 * with "one way" in the search string.
 *
 * Returns the lowest price found (USD), or null on failure.
 * Hard timeout: 30 s total per request.
 */

const { chromium } = require('playwright');

const SCRAPE_TIMEOUT_MS = 30_000;

// ─── User-agent pool ──────────────────────────────────────────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ─── Random delay 5–10 s between requests ────────────────────────────────────

function randomDelay() {
  const ms = 5000 + Math.random() * 5000;
  return new Promise((r) => setTimeout(r, ms));
}

// ─── URL builder ──────────────────────────────────────────────────────────────

/**
 * Builds a Google Flights URL that forces USD pricing.
 *   gl=us  → country: United States
 *   hl=en  → language: English
 *   curr=USD → currency: US Dollar
 *
 * @param {string} origin       IATA code
 * @param {string} destination  IATA code
 * @param {string} date         YYYY-MM-DD (outbound)
 * @param {string} [returnDate] YYYY-MM-DD — if set, round-trip search
 */
function buildUrl(origin, destination, date, returnDate) {
  const o = origin.toUpperCase();
  const d = destination.toUpperCase();
  let q;

  if (returnDate) {
    // "round trip" at the end avoids the ambiguous second "to" in the date range
    q = `round trip flights from ${o} to ${d} ${date} ${returnDate}`;
  } else {
    q = `one way flights from ${o} to ${d} ${date}`;
  }

  return (
    'https://www.google.com/travel/flights?q=' +
    encodeURIComponent(q) +
    '&gl=us&hl=en&curr=USD'
  );
}

// ─── Price extraction ─────────────────────────────────────────────────────────

/**
 * Extracts all USD prices from the page and returns the lowest.
 *
 * Strategy (in order of reliability):
 *  1. .YMlIz elements that start with "$"  → clean "$138" strings
 *  2. aria-label containing "US dollars"   → "138 US dollars"
 *  3. Regex $XXX scan on full body text    → last-resort fallback
 */
async function extractLowestPrice(page, tag) {
  // Debug: page title helps detect CAPTCHAs or redirects
  const title = await page.title().catch(() => '(no title)');
  console.log(`[flights] Page title for ${tag}: "${title}"`);

  // Wait for price elements to appear (up to 12 s)
  let selectorFound = false;
  try {
    await page.waitForSelector('.YMlIz', { timeout: 12000 });
    selectorFound = true;
    console.log(`[flights] .YMlIz selector found for ${tag}`);
  } catch {
    console.log(`[flights] .YMlIz selector NOT found within 12 s for ${tag} — trying fallbacks`);
  }

  const prices = [];

  // 1. .YMlIz — filter to entries that look like "$NNN"
  const ymText = await page.$$eval('.YMlIz', (els) =>
    els.map((e) => e.textContent.trim())
  ).catch(() => []);

  console.log(`[flights] .YMlIz raw texts for ${tag}:`, ymText.slice(0, 10));

  for (const t of ymText) {
    if (/^\$[\d,]+$/.test(t)) {
      const n = parseFloat(t.replace(/[^0-9.]/g, ''));
      if (n >= 20 && n <= 20000) prices.push(n);
    }
  }

  // 2. aria-label "NNN US dollars"
  if (!prices.length) {
    console.log(`[flights] Trying aria-label fallback for ${tag}…`);
    const ariaTexts = await page.$$eval('[aria-label]', (els) =>
      els.map((e) => e.getAttribute('aria-label') || '')
         .filter((a) => a.includes('US dollars') || a.includes('dollar'))
    ).catch(() => []);

    console.log(`[flights] aria-label dollar texts for ${tag}:`, ariaTexts.slice(0, 5));

    for (const t of ariaTexts) {
      const m = t.match(/([\d,]+)\s*US\s*dollars?/i);
      if (m) {
        const n = parseFloat(m[1].replace(/,/g, ''));
        if (n >= 20 && n <= 20000) prices.push(n);
      }
    }
  }

  // 3. Body text regex fallback
  if (!prices.length) {
    console.log(`[flights] Trying body-text regex fallback for ${tag}…`);
    const body = await page.evaluate(() => document.body.innerText).catch(() => '');
    const matches = body.match(/\$\s?([\d,]+)/g) || [];
    console.log(`[flights] Body $ matches for ${tag}:`, matches.slice(0, 10));
    for (const t of matches) {
      const n = parseFloat(t.replace(/[^0-9.]/g, ''));
      if (n >= 20 && n <= 20000) prices.push(n);
    }
  }

  return prices.length ? Math.min(...prices) : null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch the current lowest price for a flight from Google Flights.
 *
 * Note: Google always shows round-trip totals. When searching one-way
 * ("one way" in query), it shows the one-way price directly.
 *
 * @param {string} origin       IATA airport code (e.g. "LIM")
 * @param {string} destination  IATA airport code (e.g. "TCQ")
 * @param {string} date         YYYY-MM-DD
 * @param {string} [returnDate] YYYY-MM-DD — if provided, round-trip search
 * @returns {Promise<number|null>} lowest price in USD, or null on failure
 */
async function fetchPrice(origin, destination, date, returnDate) {
  const url = buildUrl(origin, destination, date, returnDate);
  const ua  = randomUA();
  const tag = `${origin.toUpperCase()}→${destination.toUpperCase()} ${date}${returnDate ? ' RT' : ' OW'}`;

  console.log(`[flights] Querying: ${tag}`);
  console.log(`[flights] URL: ${url}`);
  console.log(`[flights] User-Agent: ${ua.slice(0, 60)}…`);

  let browser;

  // Hard 30 s timeout — rejects if the entire scraping takes longer
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`Scraping timeout after ${SCRAPE_TIMEOUT_MS / 1000} s`)),
      SCRAPE_TIMEOUT_MS
    )
  );

  const scrapePromise = (async () => {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: ua,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    const page = await context.newPage();

    // Block images, fonts and media to speed up loading
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media'].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    console.log(`[flights] Navigating to Google Flights for ${tag}…`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    console.log(`[flights] Page loaded for ${tag}`);

    const price = await extractLowestPrice(page, tag);

    if (price !== null) {
      console.log(`[flights] ✅ Lowest price for ${tag}: $${price} USD`);
    } else {
      console.log(`[flights] ⚠️  No price found for ${tag}`);
    }

    return price;
  })();

  try {
    return await Promise.race([scrapePromise, timeoutPromise]);
  } catch (err) {
    console.error(`[flights] ❌ Error for ${tag}: ${err.message}`);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await randomDelay();
  }
}

module.exports = { fetchPrice };
