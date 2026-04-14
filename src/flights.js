/**
 * Flight price provider via SerpApi (Google Flights engine).
 *
 * Docs: https://serpapi.com/google-flights-api
 * Prices are returned in USD (currency: USD).
 * Returns the lowest price found, or null on failure.
 */

require('dotenv').config();

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const SERPAPI_URL = 'https://serpapi.com/search';

/**
 * Fetch the current lowest price for a flight via SerpApi.
 *
 * @param {string} origin       IATA airport code (e.g. "LIM")
 * @param {string} destination  IATA airport code (e.g. "TCQ")
 * @param {string} date         YYYY-MM-DD (outbound)
 * @param {string} [returnDate] YYYY-MM-DD — if provided, round-trip search
 * @returns {Promise<number|null>} lowest price in USD, or null on failure
 */
async function fetchPrice(origin, destination, date, returnDate) {
  const tag = `${origin.toUpperCase()}→${destination.toUpperCase()} ${date}${returnDate ? ' RT' : ' OW'}`;

  if (!SERPAPI_KEY) {
    console.error('[flights] SERPAPI_KEY is not set in environment variables');
    return null;
  }

  const params = new URLSearchParams({
    engine:        'google_flights',
    api_key:       SERPAPI_KEY,
    departure_id:  origin.toUpperCase(),
    arrival_id:    destination.toUpperCase(),
    outbound_date: date,
    currency:      'USD',
    hl:            'en',
  });

  if (returnDate) {
    params.set('return_date', returnDate);
    params.set('type', '1'); // 1 = round-trip
  } else {
    params.set('type', '2'); // 2 = one-way
  }

  console.log(`[flights] Querying SerpApi for ${tag}`);

  try {
    const res = await fetch(`${SERPAPI_URL}?${params}`);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[flights] SerpApi HTTP ${res.status} for ${tag}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();

    // SerpApi returns best_flights and other_flights arrays
    const allFlights = [
      ...(data.best_flights  || []),
      ...(data.other_flights || []),
    ];

    if (!allFlights.length) {
      console.log(`[flights] No flights returned by SerpApi for ${tag}`);
      return null;
    }

    const prices = allFlights
      .map((f) => f.price)
      .filter((p) => typeof p === 'number' && p > 0);

    if (!prices.length) {
      console.log(`[flights] No valid prices in SerpApi response for ${tag}`);
      return null;
    }

    const lowest = Math.min(...prices);
    console.log(`[flights] Lowest price for ${tag}: $${lowest} USD`);
    return lowest;

  } catch (err) {
    console.error(`[flights] Error fetching price for ${tag}: ${err.message}`);
    return null;
  }
}

module.exports = { fetchPrice };
