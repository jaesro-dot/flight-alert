require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { addAlert, getAlertsByChatId, removeAlert, getHistoryByChatId } = require('./storage');
const { fetchFlightOptions } = require('./flights');
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

// Selecciones pendientes: entre que el usuario envía /alert y toca un botón.
// Clave -> { chatId, origin, destination, date, returnDate, options }
const pendingSelections = new Map();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatAlert(a) {
  const trip = a.returnDate
    ? `${a.date} → ${a.returnDate} (ida y vuelta)`
    : `${a.date} (solo ida)`;

  // Muestra el vuelo elegido si la alerta lo tiene (alertas nuevas)
  let target = '';
  if (a.mode === 'specific' && a.targetDeparture) {
    const hora = String(a.targetDeparture).split(' ')[1] || a.targetDeparture;
    target = `\n  🎯 Vuelo: 🛫 ${hora}${a.targetAirline ? ` · ${a.targetAirline}` : ''}`;
  } else if (a.mode === 'cheapest') {
    target = `\n  🎯 El más barato de la ruta`;
  }

  return (
    `*ID:* \`${a.id}\`\n` +
    `  ${a.origin} → ${a.destination} · ${trip}` + target + `\n` +
    `  Último precio: ${a.lastPrice != null ? `*$${a.lastPrice}*` : '_sin datos aún_'}\n` +
    `  Estado: ${a.triggered ? '✅ disparada' : '⏳ vigilando'}`
  );
}

// Mensaje con las opciones más económicas y sus horarios
function formatOptionsMessage(orig, dest, date, returnDate, options) {
  const nums = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
  const tripLabel = returnDate
    ? `${date} → ${returnDate} (ida y vuelta)`
    : `${date} (solo ida)`;

  let msg = `✈️ *${orig} → ${dest}*\n📅 ${tripLabel}\n\nLas ${options.length} más económicas:\n\n`;
  options.forEach((o, i) => {
    const stops = o.stops === 0 ? 'directo' : `${o.stops} escala${o.stops > 1 ? 's' : ''}`;
    const dur = o.duration ? ` · ${o.duration}` : '';
    msg += `${nums[i]} *$${o.price}* · 🛫 ${o.departureTime} → 🛬 ${o.arrivalTime}\n`;
    msg += `     ${o.airline} · ${stops}${dur}\n\n`;
  });
  if (returnDate) msg += `_(horarios del tramo de ida; el precio es el total ida y vuelta)_\n\n`;
  msg += `_Toca el vuelo que quieres monitorear:_`;
  return msg;
}

// Teclado inline: etiqueta corta en los botones (los horarios van en el texto)
function buildOptionsKeyboard(key, options) {
  const nums = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
  const buttons = options.map((o, i) => ({
    text: `${nums[i]} $${o.price}`,
    callback_data: `pick:${key}:${i}`,
  }));

  const rows = [];
  for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3)); // filas de 3
  rows.push([{ text: '💰 Monitorear el más barato', callback_data: `pick:${key}:cheap` }]);
  return { reply_markup: { inline_keyboard: rows } };
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
      `Al crear una alerta te mostraré las opciones más económicas con su ` +
      `horario y podrás elegir cuál monitorear.\n\n` +
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

// /alert → busca opciones, las muestra con horarios y ofrece botones para elegir
bot.onText(/\/alert (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const parts = match[1].trim().split(/\s+/);

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

  bot.sendMessage(chatId, '🔍 Buscando las opciones más económicas…');

  let options;
  try {
    options = await fetchFlightOptions(orig, dest, date, isRoundTrip ? returnDate : undefined, 5);
  } catch (e) {
    console.error('[alert] fetchFlightOptions error:', e.message);
    return bot.sendMessage(chatId, '⚠️ No pude consultar vuelos ahora. Intenta de nuevo en un momento.');
  }

  console.log('[alert] opciones:', JSON.stringify(options)); // DEBUG temporal — quítalo cuando confirmes horarios

  if (!options || options.length === 0) {
    return bot.sendMessage(
      chatId,
      'No encontré vuelos para esa ruta/fecha. Verifica los códigos IATA y la fecha.'
    );
  }

  // Guarda la selección pendiente (los datos pesados NO caben en callback_data)
  const key = `${chatId}_${Date.now()}`;
  pendingSelections.set(key, {
    chatId: String(chatId),
    origin: orig,
    destination: dest,
    date,
    returnDate: isRoundTrip ? returnDate : undefined,
    options,
  });
  setTimeout(() => pendingSelections.delete(key), 10 * 60 * 1000); // TTL 10 min

  bot.sendMessage(
    chatId,
    formatOptionsMessage(orig, dest, date, isRoundTrip ? returnDate : undefined, options),
    { parse_mode: 'Markdown', ...buildOptionsKeyboard(key, options) }
  );
});

// Elección de vuelo (toque de botón)
bot.on('callback_query', async (query) => {
  const data = query.data || '';
  if (!data.startsWith('pick:')) return;

  const [, key, sel] = data.split(':');
  const pending = pendingSelections.get(key);

  if (!pending) {
    return bot.answerCallbackQuery(query.id, {
      text: 'La selección expiró. Envía /alert de nuevo.',
      show_alert: true,
    });
  }

  let chosen, mode;
  if (sel === 'cheap') {
    chosen = pending.options[0];
    mode = 'cheapest';
  } else {
    chosen = pending.options[parseInt(sel, 10)];
    mode = 'specific';
  }
  if (!chosen) {
    return bot.answerCallbackQuery(query.id, { text: 'Opción no válida.' });
  }

  // Crea la alerta. Los campos mode/targetDeparture/targetAirline/lastPrice
  // se envían para que storage los use; si storage aún no los maneja, los ignora
  // y la alerta se crea igual (compatibilidad).
  const alert = addAlert({
    chatId: pending.chatId,
    origin: pending.origin,
    destination: pending.destination,
    date: pending.date,
    returnDate: pending.returnDate,
    mode,
    targetDeparture: mode === 'specific' ? chosen.departureRaw : null,
    targetAirline: mode === 'specific' ? chosen.airline : null,
    lastPrice: chosen.price,
  });

  pendingSelections.delete(key);
  bot.answerCallbackQuery(query.id, { text: '✅ Alerta creada' });

  const tripLabel = pending.returnDate
    ? `${pending.date} → ${pending.returnDate} (ida y vuelta)`
    : `${pending.date} (solo ida)`;

  const modeLabel = mode === 'cheapest'
    ? 'el vuelo más barato de la ruta'
    : `salida 🛫 ${chosen.departureTime} → 🛬 ${chosen.arrivalTime} · ${chosen.airline}`;

  const confirmation =
    `✅ *¡Alerta creada!*\n\n` +
    `✈️ *${pending.origin} → ${pending.destination}*\n` +
    `📅 ${tripLabel}\n` +
    `🎯 Monitoreando: ${modeLabel}\n` +
    `💰 Precio base: *$${chosen.price}*\n` +
    `🆔 \`${alert.id}\`\n\n` +
    `_Te avisaré cuando el precio baje._`;

  // Reemplaza el mensaje de opciones por la confirmación (quita los botones)
  bot.editMessageText(confirmation, {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    parse_mode: 'Markdown',
  });
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

  // Muestra el horario del vuelo elegido si la alerta lo tiene
  const horario = alert.targetDeparture
    ? `🛫 ${String(alert.targetDeparture).split(' ')[1] || alert.targetDeparture}` +
      `${alert.targetAirline ? ` · ${alert.targetAirline}` : ''}\n`
    : '';

  const msg =
    `🚨 *¡Precio bajó!*\n\n` +
    `✈️ *${alert.origin} → ${alert.destination}*\n` +
    `📅 ${tripLabel}\n` +
    (horario ? `${horario}` : '') +
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
