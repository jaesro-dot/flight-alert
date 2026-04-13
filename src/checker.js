const { getAllAlerts, markTriggered, updateLastPrice, addPriceHistory } = require('./storage');
const { fetchPrice } = require('./flights');

/**
 * Revisa todas las alertas activas.
 * Registra cada precio consultado en el historial.
 * Solo notifica cuando el precio bajó respecto al último valor conocido
 * Y además está por debajo del precio objetivo.
 */
async function checkAlerts() {
  const alerts = getAllAlerts().filter((a) => !a.triggered);
  const triggered = [];

  for (const alert of alerts) {
    const price = await fetchPrice(
      alert.origin, alert.destination, alert.date, alert.returnDate || undefined
    );

    if (price === null) continue;

    const lastPrice = alert.lastPrice;
    const priceDrop = lastPrice != null && price < lastPrice;

    console.log(
      `[checker] ${alert.origin}→${alert.destination} ${alert.date}` +
      `${alert.returnDate ? ' RT' : ' OW'}: $${price}` +
      ` (último: ${lastPrice != null ? '$' + lastPrice : 'sin datos'}` +
      `${priceDrop ? ' ↓ bajó' : ''})`
    );

    // Registrar precio en el historial y actualizar último conocido
    addPriceHistory(alert.id, price);
    updateLastPrice(alert.id, price);

    // Disparar solo si el precio bajó respecto al último registrado
    if (priceDrop) {
      markTriggered(alert.id);
      triggered.push({ ...alert, currentPrice: price, previousPrice: lastPrice });
    }
  }

  return triggered;
}

module.exports = { checkAlerts };
