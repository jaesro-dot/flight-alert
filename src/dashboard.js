require('dotenv').config();
const express = require('express');
const { getAllAlerts, getAllHistory, getRouteStats } = require('./storage');

const app = express();
const PORT = parseInt(process.env.DASHBOARD_PORT || '3000', 10);

// ─── API ──────────────────────────────────────────────────────────────────────

app.get('/api/dashboard', (_req, res) => {
  const alerts  = getAllAlerts();
  const history = getAllHistory();
  const stats   = getRouteStats();

  // Agrupar historial por alert_id para los gráficos
  const historyByAlert = {};
  for (const row of history) {
    if (!historyByAlert[row.alert_id]) historyByAlert[row.alert_id] = [];
    historyByAlert[row.alert_id].push({ price: row.price, checked_at: row.checked_at });
  }
  // Historial ordenado cronológicamente por alert (para los gráficos)
  for (const key of Object.keys(historyByAlert)) {
    historyByAlert[key].sort((a, b) => new Date(a.checked_at) - new Date(b.checked_at));
  }

  res.json({ alerts, history, stats, historyByAlert });
});

// ─── Página principal ─────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML);
});

// ─── HTML embebido ────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Flight Alert — Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      padding: 1.5rem;
      min-height: 100vh;
    }
    h1 { font-size: 1.5rem; margin-bottom: .25rem; }
    .subtitle { color: #94a3b8; font-size: .85rem; margin-bottom: 2rem; }
    .refresh-badge {
      display: inline-block;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 999px;
      padding: .2rem .75rem;
      font-size: .75rem;
      color: #7dd3fc;
      margin-left: .75rem;
      vertical-align: middle;
    }
    h2 { font-size: 1.1rem; color: #7dd3fc; margin: 2rem 0 1rem; }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .stat-card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: .75rem;
      padding: 1rem 1.25rem;
    }
    .stat-card .route { font-weight: 600; font-size: 1rem; }
    .stat-card .nums { margin-top: .5rem; font-size: .85rem; color: #94a3b8; }
    .stat-card .nums span { color: #e2e8f0; font-weight: 600; }
    .charts-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
      gap: 1.5rem;
      margin-bottom: 2rem;
    }
    .chart-card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: .75rem;
      padding: 1.25rem;
    }
    .chart-card h3 { font-size: .9rem; color: #94a3b8; margin-bottom: .75rem; }
    .chart-card .badge {
      display: inline-block;
      font-size: .7rem;
      border-radius: .35rem;
      padding: .1rem .45rem;
      margin-left: .5rem;
      font-weight: 600;
    }
    .badge-watch  { background: #1e3a5f; color: #7dd3fc; }
    .badge-done   { background: #14432a; color: #6ee7b7; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: .82rem;
    }
    thead th {
      background: #1e293b;
      text-align: left;
      padding: .6rem .75rem;
      color: #7dd3fc;
      position: sticky;
      top: 0;
    }
    tbody tr:nth-child(even) { background: #1a2437; }
    tbody tr:hover { background: #243249; }
    td { padding: .5rem .75rem; border-bottom: 1px solid #1e293b; }
    .table-wrap { max-height: 400px; overflow-y: auto; border: 1px solid #334155; border-radius: .75rem; }
    .empty { color: #64748b; font-size: .9rem; padding: 1rem 0; }
    #last-update { color: #475569; font-size: .75rem; margin-top: 2.5rem; text-align: right; }
    .price-down { color: #6ee7b7; }
    .price-up   { color: #fca5a5; }
  </style>
</head>
<body>
  <h1>✈️ Flight Alert
    <span class="refresh-badge">↻ auto cada 5 min</span>
  </h1>
  <p class="subtitle">Dashboard de monitoreo de precios de vuelos</p>

  <h2>📊 Estadísticas por ruta</h2>
  <div class="stats-grid" id="stats-grid">
    <p class="empty">Cargando…</p>
  </div>

  <h2>📈 Historial de precios</h2>
  <div class="charts-grid" id="charts-grid">
    <p class="empty">Cargando…</p>
  </div>

  <h2>📋 Registro completo</h2>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Ruta</th>
          <th>Fecha(s)</th>
          <th>Tipo</th>
          <th>Precio</th>
          <th>Revisado</th>
        </tr>
      </thead>
      <tbody id="history-body">
        <tr><td colspan="5" class="empty">Cargando…</td></tr>
      </tbody>
    </table>
  </div>

  <p id="last-update"></p>

<script>
const PALETTE = [
  '#7dd3fc','#6ee7b7','#fcd34d','#f9a8d4','#c4b5fd',
  '#fdba74','#a5f3fc','#bbf7d0','#fef08a','#fbcfe8',
];

const charts = {};

async function loadDashboard() {
  let data;
  try {
    const resp = await fetch('/api/dashboard');
    data = await resp.json();
  } catch (e) {
    console.error('Error al cargar datos', e);
    return;
  }

  renderStats(data.stats);
  renderCharts(data.alerts, data.historyByAlert);
  renderTable(data.history);
  document.getElementById('last-update').textContent =
    'Última actualización: ' + new Date().toLocaleString('es');
}

function renderStats(stats) {
  const el = document.getElementById('stats-grid');
  if (!stats.length) {
    el.innerHTML = '<p class="empty">Sin datos de rutas todavía.</p>';
    return;
  }
  el.innerHTML = stats.map(s => \`
    <div class="stat-card">
      <div class="route">✈️ \${s.origin} → \${s.destination}</div>
      <div class="nums">
        Mín: <span class="price-down">$\${s.min_price}</span> &nbsp;
        Máx: <span class="price-up">$\${s.max_price}</span> &nbsp;
        Prom: <span>$\${s.avg_price}</span><br>
        Consultas: <span>\${s.checks}</span>
      </div>
    </div>
  \`).join('');
}

function renderCharts(alerts, historyByAlert) {
  const grid = document.getElementById('charts-grid');

  const alertsWithHistory = alerts.filter(a => historyByAlert[a.id]?.length > 0);
  if (!alertsWithHistory.length) {
    grid.innerHTML = '<p class="empty">Sin historial de precios todavía. Los datos aparecerán tras la primera revisión automática.</p>';
    return;
  }

  // Crear o actualizar cards
  alertsWithHistory.forEach((alert, idx) => {
    const hist = historyByAlert[alert.id] || [];
    const color = PALETTE[idx % PALETTE.length];
    const cardId = 'chart-card-' + alert.id;
    const canvasId = 'chart-' + alert.id;
    const statusBadge = alert.triggered
      ? '<span class="badge badge-done">✅ disparada</span>'
      : '<span class="badge badge-watch">⏳ vigilando</span>';

    if (!document.getElementById(cardId)) {
      const card = document.createElement('div');
      card.className = 'chart-card';
      card.id = cardId;
      const tripLabel = alert.returnDate
        ? \`\${alert.date} → \${alert.returnDate}\`
        : alert.date;
      card.innerHTML = \`
        <h3>\${alert.origin} → \${alert.destination} · \${tripLabel}
          \${statusBadge}
        </h3>
        <canvas id="\${canvasId}" height="180"></canvas>
      \`;
      grid.appendChild(card);
    }

    const labels = hist.map(h => {
      const d = new Date(h.checked_at);
      return d.toLocaleString('es', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
    });
    const prices = hist.map(h => h.price);

    if (charts[canvasId]) {
      charts[canvasId].data.labels = labels;
      charts[canvasId].data.datasets[0].data = prices;
      charts[canvasId].update();
    } else {
      const ctx = document.getElementById(canvasId).getContext('2d');
      charts[canvasId] = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Precio USD',
            data: prices,
            borderColor: color,
            backgroundColor: color + '22',
            tension: 0.3,
            pointRadius: 4,
            fill: true,
          }],
        },
        options: {
          responsive: true,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: ctx => ' $' + ctx.parsed.y,
                afterLabel: ctx => {
                  const diff = ctx.dataIndex > 0
                    ? ctx.parsed.y - prices[ctx.dataIndex - 1]
                    : null;
                  if (diff === null) return '';
                  return diff < 0 ? '▼ ' + Math.abs(diff) : '▲ ' + diff;
                },
              },
            },
            },
          scales: {
            x: { ticks: { color: '#64748b', maxRotation: 45, font: { size: 10 } }, grid: { color: '#1e293b' } },
            y: { ticks: { color: '#94a3b8', callback: v => '$' + v }, grid: { color: '#263349' } },
          },
        },
      });
    }
  });

  // Eliminar cards de alertas que ya no existen
  grid.querySelectorAll('.chart-card').forEach(card => {
    const aid = card.id.replace('chart-card-', '');
    if (!alertsWithHistory.find(a => a.id === aid)) card.remove();
  });
}

function renderTable(history) {
  const tbody = document.getElementById('history-body');
  if (!history.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">Sin registros todavía.</td></tr>';
    return;
  }
  tbody.innerHTML = history.slice(0, 500).map(row => {
    const ts = new Date(row.checked_at).toLocaleString('es');
    const tripType = row.return_date ? 'I+V' : 'OW';
    const dates    = row.return_date ? \`\${row.date} → \${row.return_date}\` : row.date;
    return \`<tr>
      <td>\${row.origin} → \${row.destination}</td>
      <td>\${dates}</td>
      <td>\${tripType}</td>
      <td class="price-down">$\${row.price}</td>
      <td>\${ts}</td>
    </tr>\`;
  }).join('');
}

// Arrancar y programar
loadDashboard();
setInterval(loadDashboard, 5 * 60 * 1000);
</script>
</body>
</html>`;

// ─── Iniciar servidor ─────────────────────────────────────────────────────────

function startDashboard() {
  app.listen(PORT, () => {
    console.log(`Dashboard disponible en http://localhost:${PORT}`);
  });
}

module.exports = { startDashboard };
