const db = require('./db');

// ─── Alerts ───────────────────────────────────────────────────────────────────

function addAlert({ chatId, origin, destination, date, returnDate }) {
  const id = Date.now().toString();
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO alerts (id, chat_id, origin, destination, date, return_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, chatId, origin, destination, date, returnDate || null, createdAt);
  return getAlertById(id);
}

function getAlertById(id) {
  const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
  return row ? rowToAlert(row) : null;
}

function getAlertsByChatId(chatId) {
  return db.prepare('SELECT * FROM alerts WHERE chat_id = ? ORDER BY created_at DESC')
    .all(chatId)
    .map(rowToAlert);
}

function getAllAlerts() {
  return db.prepare('SELECT * FROM alerts ORDER BY created_at DESC').all().map(rowToAlert);
}

function removeAlert(chatId, alertId) {
  const result = db.prepare('DELETE FROM alerts WHERE id = ? AND chat_id = ?').run(alertId, chatId);
  return result.changes > 0;
}

function markTriggered(alertId) {
  db.prepare(`
    UPDATE alerts SET triggered = 1, triggered_at = ? WHERE id = ?
  `).run(new Date().toISOString(), alertId);
}

function updateLastPrice(alertId, price) {
  db.prepare('UPDATE alerts SET last_price = ? WHERE id = ?').run(price, alertId);
}

// ─── Price history ────────────────────────────────────────────────────────────

function addPriceHistory(alertId, price) {
  db.prepare(`
    INSERT INTO price_history (alert_id, price, checked_at) VALUES (?, ?, ?)
  `).run(alertId, price, new Date().toISOString());
}

function getHistoryByAlertId(alertId) {
  return db.prepare(`
    SELECT price, checked_at FROM price_history
    WHERE alert_id = ?
    ORDER BY checked_at ASC
  `).all(alertId);
}

function getHistoryByChatId(chatId) {
  return db.prepare(`
    SELECT ph.alert_id, a.origin, a.destination, a.date,
           ph.price, ph.checked_at
    FROM price_history ph
    JOIN alerts a ON a.id = ph.alert_id
    WHERE a.chat_id = ?
    ORDER BY ph.checked_at ASC
  `).all(chatId);
}

function getRouteStats() {
  return db.prepare(`
    SELECT a.origin, a.destination,
           COUNT(ph.id)      AS checks,
           MIN(ph.price)     AS min_price,
           MAX(ph.price)     AS max_price,
           ROUND(AVG(ph.price), 2) AS avg_price
    FROM price_history ph
    JOIN alerts a ON a.id = ph.alert_id
    GROUP BY a.origin, a.destination
    ORDER BY a.origin, a.destination
  `).all();
}

function getAllHistory() {
  return db.prepare(`
    SELECT ph.id, a.origin, a.destination, a.date, a.return_date, a.chat_id,
           ph.alert_id, ph.price, ph.checked_at
    FROM price_history ph
    JOIN alerts a ON a.id = ph.alert_id
    ORDER BY ph.checked_at DESC
  `).all();
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function rowToAlert(row) {
  return {
    id:          row.id,
    chatId:      row.chat_id,
    origin:      row.origin,
    destination: row.destination,
    date:        row.date,
    returnDate:  row.return_date || null,
    lastPrice:   row.last_price,
    triggered:   row.triggered === 1,
    triggeredAt: row.triggered_at,
    createdAt:   row.created_at,
  };
}

module.exports = {
  addAlert, getAlertById, getAlertsByChatId, getAllAlerts,
  removeAlert, markTriggered, updateLastPrice,
  addPriceHistory, getHistoryByAlertId, getHistoryByChatId,
  getRouteStats, getAllHistory,
};
