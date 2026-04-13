/**
 * Prueba aislada de scraping — no afecta el bot.
 * Uso: node test-scraping.js
 */
const { fetchPrice } = require('./src/flights');

console.log('=== TEST SCRAPING INICIADO ===');
console.log('Hora de inicio:', new Date().toISOString());
console.log('Ruta: LIM → TCQ  |  Ida: 2026-05-09  |  Vuelta: 2026-05-10');
console.log('Timeout máximo: 30 s');
console.log('─────────────────────────────────────────\n');

fetchPrice('LIM', 'TCQ', '2026-05-09', '2026-05-10')
  .then((price) => {
    console.log('\n─────────────────────────────────────────');
    console.log('Hora de fin:', new Date().toISOString());
    if (price !== null) {
      console.log(`RESULTADO: $${price} USD`);
    } else {
      console.log('RESULTADO: null — no se encontró precio (o timeout)');
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nERROR INESPERADO:', err);
    process.exit(1);
  });
