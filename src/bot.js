require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { addAlert, getAlertsByChatId, removeAlert, getHistoryByChatId } = require('./storage');
const { fetchPrice } = require('./flights');
const { checkAlerts } = require('./checker');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('Error: TELEGRAM_BOT_TOKEN no está definido en .env');
  process.exit(1);
}

const INTERVAL_MINUTES = parseInt(process.env.CHECK_INTERVAL_MINUTES || '120', 10);
const START_HOUR = parseInt(process.env.CHECK_START_HOUR || '8', 10);
const END_HOUR   = parseInt(process.env.CHECK_END_HOUR   || '23', 10);

const bot = new TelegramBot(TOKEN, { polling: true });

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatAlert(a) {
  const trip = a.returnDate
    ? `${a.date} → ${a.returnDate} (ida y vuelta)`
    : `${a.date} (solo ida)`;
  return (
    `*ID:* \`${a.id}\`\n` +
    `  ${a.origin} → ${a.destination} · ${trip}\n` +
    `  Último precio: ${a.lastPrice != null ? `*$${a.lastPrice}*` : '_sin datos aún_'}\n` +
    `  Estado: ${a.triggered ? '✅ disparada' : '⏳ vigilando'}`
  );
}

// ─── Comandos ─────────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `✈️ *Bot de Alertas de Vuelos*\n\n` +
      `Monitorea precios en Google Flights y avisa cuando el precio baje.\n\n` +
      `*Comandos:*\n` +
      `/alert <origen> <destino> <fecha-ida> — Solo ida\n` +
      `/alert <origen> <destino> <fecha-ida> <fecha-vuelta> — Ida y vuelta\n` +
      `/list — Ver alertas activas\n` +
      `/remove <id> — Eliminar una alerta\n` +
      `/check — Revisar precios ahora\n` +
      `/grafico — Ver historial de precios\n\n` +
      `*Ejemplos:*\n` +
      `/alert LIM TCQ 2026-05-09\n` +
      `/alert LIM MIA 2026-06-01 2026-06-10`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/routes/, (msg) => {
  const routes = [
    'JFK ↔ LAX', 'JFK ↔ LHR', 'LAX ↔ ORD',
    'SFO ↔ MIA', 'BOS ↔ SEA',
  ];
  bot.sendMessage(
    msg.chat.id,
    `*Rutas disponibles:*\n${routes.map((r) => `• ${r}`).join('\n')}`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/alert (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const parts = match[1].trim().split(/\s+/);

  // Validate: 3 parts (OW) or 4 parts (RT), all dates in YYYY-MM-DD
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const [origin, destination, date, returnDate] = parts;

  if (
    parts.length < 3 || parts.length > 4 ||
    !origin || !destination ||
    !dateRe.test(date) ||
    (parts.length === 4 && !dateRe.test(returnDate))
  ) {
    return bot.sendMessage(
      chatId,
      '❌ Formato incorrecto.\n\n' +
      '*Solo ida:* `/alert LIM TCQ 2026-05-09`\n' +
      '*Ida y vuelta:* `/alert LIM MIA 2026-06-01 2026-06-10`',
      { parse_mode: 'Markdown' }
    );
  }

  const orig = origin.toUpperCase();
  const dest = destination.toUpperCase();
  const isRoundTrip = parts.length === 4;

  bot.sendMessage(chatId, '🔍 Consultando precio actual en Google Flights…');

  const currentPrice = await fetchPrice(orig, dest, date, isRoundTrip ? returnDate : undefined);

  const alert = addAlert({
    chatId: String(chatId),
    origin: orig,
    destination: dest,
    date,
    returnDate: isRoundTrip ? returnDate : undefined,
  });

  const tripLabel = isRoundTrip
    ? `${date} → ${returnDate} (ida y vuelta)`
    : `${date} (solo ida)`;

  let reply =
    `✅ ¡Alerta creada!\n` +
    `Ruta: *${alert.origin} → ${alert.destination}*\n` +
    `Fechas: ${tripLabel}\n` +
    `ID de alerta: \`${alert.id}\``;

  if (currentPrice !== null) {
    reply += `\n\nPrecio actual: *$${currentPrice}*\n` +
      `_Te avisaré si el precio baja respecto a este valor._`;
  } else {
    reply += `\n\n⚠️ No se pudo obtener el precio ahora. Se intentará en la próxima revisión automática.`;
  }

  bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
});

bot.onText(/\/list/, (msg) => {
  const chatId = msg.chat.id;
  const alerts = getAlertsByChatId(String(chatId));

  if (alerts.length === 0) {
    return bot.sendMessage(chatId, 'No tienes alertas activas. Usa /alert para crear una.');
  }

  const text = alerts.map(formatAlert).join('\n\n');
  bot.sendMessage(chatId, `*Tus alertas:*\n\n${text}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/remove (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const alertId = match[1].trim();
  const removed = removeAlert(String(chatId), alertId);

  if (removed) {
    bot.sendMessage(chatId, `✅ Alerta \`${alertId}\` eliminada.`, { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(chatId, `❌ Alerta no encontrada. Verifica el ID con /list.`);
  }
});

bot.onText(/\/check/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🔍 Revisando precios...');
  const triggered = await checkAlerts();

  const mine = triggered.filter((a) => a.chatId === String(chatId));

  if (mine.length === 0) {
    bot.sendMessage(chatId, 'Sin alertas disparadas. Los precios siguen por encima de tu objetivo o no hubo rebaja.');
  } else {
    for (const a of mine) {
      sendTriggerNotification(a);
    }
  }
});

// ─── /grafico ────────────────────────────────────────────────────────────────

const PALETTE = [
  '#7dd3fc', '#6ee7b7', '#fcd34d', '#f9a8d4', '#c4b5fd',
  '#fdba74', '#a5f3fc', '#bbf7d0', '#fef08a', '#fbcfe8',
];

bot.onText(/\/grafico/, async (msg) => {
  const chatId = msg.chat.id;
  const rows = getHistoryByChatId(String(chatId));

  if (rows.length === 0) {
    return bot.sendMessage(
      chatId,
      '📭 Sin historial de precios todavía. Usa /check o espera la revisión automática.'
    );
  }

  // Agrupar por ruta+fecha para datasets
  const groups = {};
  for (const r of rows) {
    const key = `${r.origin}→${r.destination} (${r.date})`;
    if (!groups[key]) groups[key] = { points: [] };
    groups[key].points.push({ x: r.checked_at, y: r.price });
  }

  // Eje X unificado (todos los timestamps únicos, ordenados)
  const allTs = [...new Set(rows.map(r => r.checked_at))].sort();
  const labels = allTs.map(ts => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  });

  const datasets = Object.entries(groups).map(([label, { points }], idx) => {
    // Mapear precios a los timestamps globales (null si no hay dato en ese ts)
    const priceMap = Object.fromEntries(points.map(p => [p.x, p.y]));
    return {
      label,
      data: allTs.map(ts => priceMap[ts] ?? null),
      borderColor: PALETTE[idx % PALETTE.length],
      backgroundColor: 'transparent',
      tension: 0.3,
      pointRadius: 4,
      spanGaps: true,
    };
  });

  const canvas = new ChartJSNodeCanvas({ width: 900, height: 480, backgroundColour: '#1e293b' });
  const buffer = await canvas.renderToBuffer({
    type: 'line',
    data: { labels, datasets },
    options: {
      plugins: {
        legend: {
          labels: { color: '#e2e8f0', font: { size: 12 } },
        },
        title: {
          display: true,
          text: 'Historial de precios — tus alertas',
          color: '#7dd3fc',
          font: { size: 16 },
        },
      },
      scales: {
        x: {
          ticks: { color: '#94a3b8', maxRotation: 45, font: { size: 10 } },
          grid:  { color: '#263349' },
        },
        y: {
          ticks: { color: '#94a3b8', callback: v => '$' + v },
          grid:  { color: '#263349' },
        },
      },
    },
  });

  await bot.sendPhoto(chatId, buffer, {
    caption: `📈 Historial de precios (${Object.keys(groups).length} ruta${Object.keys(groups).length !== 1 ? 's' : ''})`,
  });
});

// ─── Notificación de alerta disparada ────────────────────────────────────────

function sendTriggerNotification(alert) {
  const tripLabel = alert.returnDate
    ? `${alert.date} → ${alert.returnDate} (ida y vuelta)`
    : `${alert.date} (solo ida)`;
  const drop = alert.previousPrice - alert.currentPrice;
  const pct  = Math.round((drop / alert.previousPrice) * 100);

  const msg =
    `🚨 *¡Precio bajó!*\n\n` +
    `✈️ *${alert.origin} → ${alert.destination}*\n` +
    `📅 ${tripLabel}\n` +
    `💰 Precio actual: *$${alert.currentPrice}*\n` +
    `📉 Precio anterior: *$${alert.previousPrice}* (↓ $${drop} · ${pct}%)\n\n` +
    `¡Reserva ahora antes de que suba!`;

  bot.sendMessage(alert.chatId, msg, { parse_mode: 'Markdown' });
}

// ─── Programador con ventana horaria ─────────────────────────────────────────

const cronExpression = `*/${INTERVAL_MINUTES} * * * *`;
console.log(
  `Programador: revisión cada ${INTERVAL_MINUTES} min, ` +
  `activo entre las ${START_HOUR}:00 y las ${END_HOUR}:00.`
);

cron.schedule(cronExpression, async () => {
  const hour = new Date().getHours();
  if (hour < START_HOUR || hour >= END_HOUR) {
    console.log(`[${new Date().toISOString()}] Fuera del horario (${START_HOUR}–${END_HOUR}h), revisión omitida.`);
    return;
  }

  console.log(`[${new Date().toISOString()}] Revisión programada de precios...`);
  const triggered = await checkAlerts();
  for (const alert of triggered) {
    sendTriggerNotification(alert);
  }
});

console.log('Bot de Alertas de Vuelos en ejecución. Pulsa Ctrl+C para detener.');
module.exports = bot;
