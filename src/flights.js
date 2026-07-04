// src/flights.js
// Consulta de vuelos vía SerpApi (Google Flights)
// Exporta:
//   fetchFlightOptions()  -> lista de opciones más baratas CON horarios  (NUEVO)
//   fetchPrice()          -> precio mínimo                               (compatibilidad)
//
// NOTA: si tu flights.js actual exporta más funciones (p.ej. para el /grafico),
// conserva esas exportaciones y solo reemplaza/añade lo de abajo.

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const SERPAPI_URL = 'https://serpapi.com/search';

// SerpApi entrega los horarios como "2026-05-09 08:15" -> devolvemos "08:15"
function soloHora(raw) {
  if (!raw) return '—';
  const partes = String(raw).split(' ');
  return partes.length === 2 ? partes[1] : raw;
}

function minutosLegibles(min) {
  if (min === undefined || min === null) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// Convierte una entrada de best_flights / other_flights a un objeto simple.
// En ida y vuelta, los segmentos corresponden al tramo de IDA y el price
// es el total estimado del viaje redondo (así lo entrega SerpApi).
function parseOpcion(entry) {
  const segs = entry.flights || [];
  if (!segs.length) return null;
  const primero = segs[0];
  const ultimo = segs[segs.length - 1];
  return {
    price: entry.price,
    airline: primero.airline || 'Varias',
    flightNumber: primero.flight_number || '',
    departureTime: soloHora(primero.departure_airport?.time),
    arrivalTime: soloHora(ultimo.arrival_airport?.time),
    departureRaw: primero.departure_airport?.time || '', // "2026-05-09 08:15" (clave para identificar el vuelo)
    stops: segs.length - 1,
    duration: minutosLegibles(entry.total_duration),
  };
}

// NUEVO: devuelve las N opciones más baratas, ordenadas por precio, con horarios.
async function fetchFlightOptions(origin, destination, departDate, returnDate, limit = 3) {
  const params = new URLSearchParams({
    engine: 'google_flights',
    departure_id: origin,
    arrival_id: destination,
    outbound_date: departDate,
    currency: 'USD',
    hl: 'es',
    api_key: SERPAPI_KEY,
  });

  if (returnDate) {
    params.set('return_date', returnDate);
    params.set('type', '1'); // ida y vuelta
  } else {
    params.set('type', '2'); // solo ida
  }

  const res = await fetch(`${SERPAPI_URL}?${params.toString()}`);
  if (!res.ok) throw new Error(`SerpApi HTTP ${res.status}`);

  const data = await res.json();
  if (data.error) throw new Error(`SerpApi: ${data.error}`);

  const todas = [...(data.best_flights || []), ...(data.other_flights || [])];

  const opciones = todas
    .map(parseOpcion)
    .filter(Boolean)
    .sort((a, b) => a.price - b.price);

  return opciones.slice(0, limit);
}

// COMPATIBILIDAD: precio mínimo (lo que usa hoy el cron / dashboard).
async function fetchPrice(origin, destination, departDate, returnDate) {
  const opciones = await fetchFlightOptions(origin, destination, departDate, returnDate, 1);
  return opciones.length ? opciones[0].price : null;
}

module.exports = { fetchPrice, fetchFlightOptions };
