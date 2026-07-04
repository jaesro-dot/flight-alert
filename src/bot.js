require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { addAlert, getAlertsByChatId, removeAlert, getHistoryByChatId } = require('./storage');
const { fetchFlightOptions, fetchReturnOptions } = require('./flights');
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

// Selecciones pendientes (entre /alert y los toques de botón).
// clave -> { chatId, origin, destination, date, returnDate, options,
//            outbound, outboundMode, returnOptions }
const pendingSelections = new Map();

const NUMS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

// ─── Helpers de formato ───────────────────────────────────────────────────────

function horaDe(raw) {
  return String(raw || '').split(' ')[1] || raw || '—';
}

function lineaOpcion(o, i) {
  const stops = o.stops === 0 ? 'directo' : `${o.stops} escala${o.stops > 1 ? 's' : ''}`;
  const dur = o.duration ? ` · ${o.duration}` : '';
  return `${NUMS[i]} *$${o.price}* · 🛫 ${o.departureTime} → 🛬 ${o.arrivalTime}\n     ${o.airline} · ${stops}${dur}\n\n`;
}

function formatAlert(a) {
  const trip = a.returnDate
    ? `${a.date} → ${a.returnDate} (ida y vuelta)`
    : `${a.date} (solo ida)`;

  let target = '';
  if (a.mode === 'specific' && a.targetDeparture) {
    target += `\n  🛫 Ida: ${horaDe(a.targetDeparture)}${a.targetAirline ? ` · ${a.targetAirline}` : ''}`;
  } else if (a.mode === 'cheapest') {
    target += `\n  🎯 El más barato de la ruta`;
  }
  if (a.returnDeparture) {
    target += `\n  🛬 Vuelta: ${horaDe(a.returnDeparture)}${a.returnAirline ? ` · ${a.returnAirline}` : ''}`;
  }

  return (
    `*ID:* \`${a.id}\`\n` +
    `  ${a.origin} → ${a.destination} · ${trip}` + target + `\n` +
    `  Último precio: ${a.lastPrice != null ? `*$${a.lastPrice}*` : '_sin datos aún_'}\n` +
    `  Estado: ${a.triggered ? '✅ disparada' : '⏳ vigilando'}`
  );
}

// Mensaje de opciones de IDA
function formatOptionsMessage(orig, dest, date, returnDate, options) {
  const tripLabel = returnDate
    ? `${date} → ${returnDate} (ida y vuelta)`
    : `${date} (solo ida)`;
  let msg = `✈️ *${orig} → ${dest}*\n📅 ${tripLabel}\n\n`;
  msg += returnDate ? `Elige el *vuelo de ida* (${options.length} más económicos):\n\n`
                    : `Las ${options.length} más económicas:\n\n`;
  options.forEach((o, i) => { msg += lineaOpcion(o, i); });
  if (returnDate) msg += `_(horarios de la ida; el precio es el total ida y vuelta)_\n\n`;
  msg += `_Toca el vuelo que quieres monitorear:_`;
  return msg;
}

// Mensaje de opciones de VUELTA (tras elegir la ida)
function formatReturnMessage(pending, outbound, returnOptions) {
  let msg = `✅ *Ida:* 🛫 ${outbound.departureTime} → 🛬 ${outbound.arrivalTime} · ${outbound.airline}\n\n`;
  msg += `Ahora elige el *vuelo de vuelta* (${pending.destination} → ${pending.origin}, ${pending.returnDate}):\n\n`;
  returnOptions.forEach((o, i) => { msg += lineaOpcion(o, i); });
  msg += `_(precio total ida y vuelta)_`;
  return msg;
}

function buildKeyboard(prefix, key, options, cheapLabel) {
  const buttons = options.map((o, i) => ({
    text: `${NUMS[i]} $${o.price}`,
    callback_data: `${prefix}:${key}:${i}`,
  }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3)); // filas de 3
  rows.push([{ text: cheapLabel, callback_data: `${prefix}:${key}:cheap` }]);
  return { reply_markup: { inline_keyboard: rows } };
}

// Crea la alerta y reemplaza el mensaje por la confirmación
function createAlertAndConfirm(query, key, pending, outbound, returnLeg, outboundMode) {
  const alert = addAlert({
    chatId: pending.chatId,
    origin: pending.origin,
    destination: pending.destination,
    date: pending.date,
    returnDate: pending.returnDate,
    mode: outboundMode,
    targetDeparture: outboundMode === 'specific' ? outbound.departureRaw : null,
    targetAirline: outboundMode === 'specific' ? outbound.airline : null,
    returnDeparture: returnLeg ? returnLeg.departureRaw : null,
    returnAirline: returnLeg ? returnLeg.airline : null,
    // En ida y vuelta, el precio de la vuelta elegida ya es el total del viaje.
    lastPrice: returnLeg ? returnLeg.price : outbound.price,
  });

  pendingSelections.delete(key);

  const tripLabel = pending.returnDate
    ? `${pending.date} → ${pending.returnDate} (ida y vuelta)`
    : `${pending.date} (solo ida)`;

  let detalle;
  if (returnLeg) {
    detalle =
      `🛫 Ida: ${outbound.departureTime} → ${outbound.arrivalTime} · ${outbound.airline}\n` +
      `🛬 Vuelta: ${returnLeg.departureTime} → ${returnLeg.arrivalTime} · ${returnLeg.airline}`;
  } else if (outboundMode === 'cheapest') {
    detalle = '🎯 el vuelo más barato de la ruta';
  } else {
    detalle = `🛫 salida ${outbound.departureTime} → ${outbound.arrivalTime} · ${outbound.airline}`;
  }

  const price = returnLeg ? returnLeg.price : outbound.price;

  const confirmation =
    `✅ *¡Alerta creada!*\n\n` +
    `✈️ *${pending.origin} → ${pending.destination}*\n` +
    `📅 ${tripLabel}\n` +
    `${detalle}\n` +
    `💰 Precio base: *$${price}*\n` +
    `🆔 \`${alert.id}\`\n\n` +
    `_Te avisaré cuando el precio baje._`;

  bot.editMessageText(confirmation, {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    parse_mode: 'Markdown',
  });
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
      `Al crear una alerta te muestro las opciones más económicas con su ` +
      `horario. En ida y vuelta eliges primero la ida y luego la vuelta.\n\n` +
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

// /alert → busca la ida, la muestra con horarios y ofrece botones
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

  if (!options || options.length === 0) {
    return bot.sendMessage(
      chatId,
      'No encontré vuelos para esa ruta/fecha. Verifica los códigos IATA y la fecha.'
    );
  }

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
    { parse_mode: 'Markdown', ...buildKeyboard('pick', key, options, '💰 Monitorear el más barato') }
  );
});

// ─── Elección de vuelos (botones) ─────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const data = query.data || '';

  // Paso 1: elección de la IDA
  if (data.startsWith('pick:')) {
    const [, key, sel] = data.split(':');
    const pending = pendingSelections.get(key);
    if (!pending) {
      return bot.answerCallbackQuery(query.id, {
        text: 'La selección expiró. Envía /alert de nuevo.', show_alert: true,
      });
    }

    const outboundMode = sel === 'cheap' ? 'cheapest' : 'specific';
    const chosen = sel === 'cheap' ? pending.options[0] : pending.options[parseInt(sel, 10)];
    if (!chosen) return bot.answerCallbackQuery(query.id, { text: 'Opción no válida.' });

    // Solo ida, o sin token de vuelta disponible → crear alerta directo
    if (!pending.returnDate || !chosen.departureToken) {
      bot.answerCallbackQuery(query.id, { text: '✅ Alerta creada' });
      return createAlertAndConfirm(query, key, pending, chosen, null, outboundMode);
    }

    // Ida y vuelta → segundo paso: buscar las vueltas para esta ida
    bot.answerCallbackQuery(query.id, { text: 'Buscando vuelos de vuelta…' });
    bot.editMessageText('🔍 Buscando vuelos de vuelta para la ida elegida…', {
      chat_id: query.message.chat.id, message_id: query.message.message_id,
    });

    let returnOptions;
    try {
      returnOptions = await fetchReturnOptions(
        pending.origin, pending.destination, pending.date, pending.returnDate,
        chosen.departureToken, 5
      );
    } catch (e) {
      console.error('[return] error:', e.message);
      return bot.editMessageText('⚠️ No pude cargar los vuelos de vuelta. Envía /alert de nuevo.', {
        chat_id: query.message.chat.id, message_id: query.message.message_id,
      });
    }

    // Sin vueltas → crear con la ida elegida
    if (!returnOptions.length) {
      return createAlertAndConfirm(query, key, pending, chosen, null, outboundMode);
    }

    pending.outbound = chosen;
    pending.outboundMode = outboundMode;
    pending.returnOptions = returnOptions;
    pendingSelections.set(key, pending);

    return bot.editMessageText(
      formatReturnMessage(pending, chosen, returnOptions),
      {
        chat_id: query.message.chat.id, message_id: query.message.message_id,
        parse_mode: 'Markdown', ...buildKeyboard('ret', key, returnOptions, '💰 La vuelta más barata'),
      }
    );
  }

  // Paso 2: elección de la VUELTA
  if (data.startsWith('ret:')) {
    const [, key, sel] = data.split(':');
    const pending = pendingSelections.get(key);
    if (!pending || !pending.returnOptions || !pending.outbound) {
      return bot.answerCallbackQuery(query.id, {
        text: 'La selección expiró. Envía /alert de nuevo.', show_alert: true,
      });
    }

    const chosenReturn = sel === 'cheap' ? pending.returnOptions[0] : pending.returnOptions[parseInt(sel, 10)];
    if (!chosenReturn) return bot.answerCallbackQuery(query.id, { text: 'Opción no válida.' });

    bot.answerCallbackQuery(query.id, { text: '✅ Alerta creada' });
    return createAlertAndConfirm(query, key, pending, pending.outbound, chosenReturn, pending.outboundMode);
  }
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

  const groups = {};
  for (const r of rows) {
    const key = `${r.origin}→${r.destination} (${r.date})`;
    if (!groups[key]) groups[key] = { points: [] };
    groups[key].points.push({ x: r.checked_at, y: r.price });
  }

  const allTs = [...new Set(rows.map(r => r.checked_at))].sort();
  const labels = allTs.map(ts => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  });

  const datasets = Object.entries(groups).map(([label, { points }], idx) => {
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
        legend: { labels: { color: '#e2e8f0', font: { size: 12 } } },
        title: {
          display: true,
          text: 'Historial de precios — tus alertas',
          color: '#7dd3fc',
          font: { size: 16 },
        },
      },
      scales: {
        x: { ticks: { color: '#94a3b8', maxRotation: 45, font: { size: 10 } }, grid: { color: '#263349' } },
        y: { ticks: { color: '#94a3b8', callback: v => '$' + v }, grid: { color: '#263349' } },
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

  let horario = '';
  if (alert.targetDeparture) {
    horario += `🛫 Ida: ${horaDe(alert.targetDeparture)}${alert.targetAirline ? ` · ${alert.targetAirline}` : ''}\n`;
  }
  if (alert.returnDeparture) {
    horario += `🛬 Vuelta: ${horaDe(alert.returnDeparture)}${alert.returnAirline ? ` · ${alert.returnAirline}` : ''}\n`;
  }

  const msg =
    `🚨 *¡Precio bajó!*\n\n` +
    `✈️ *${alert.origin} → ${alert.destination}*\n` +
    `📅 ${tripLabel}\n` +
    horario +
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
