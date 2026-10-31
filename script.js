/**
 * script.js — ServerGuard Dashboard
 * ─────────────────────────────────────────────────────────────────
 * Handles all dashboard logic:
 *   1. State management & localStorage persistence
 *   2. Server CRUD (Add / Edit / Delete)
 *   3. Dynamic live metrics simulation (per-server mock data)
 *   4. Fleet-wide metrics aggregation (top cards)
 *   5. Early Warning / Alert System (CPU > 85%, MEM > 90%, etc.)
 *   6. Dynamic filter (All / Healthy / Warning / Critical / Maintenance)
 *   7. Quick actions: Maintenance Mode toggle & Restart Service
 *   8. Toast notifications
 *   9. Live clock
 * ─────────────────────────────────────────────────────────────────
 * Data model — one server object:
 * {
 *   id:        string   — unique ID
 *   name:      string   — display name
 *   ip:        string   — IP address
 *   location:  string   — region/location label
 *   role:      string   — Web | DB | Cache | Worker | Gateway | Storage
 *   status:    string   — 'healthy' | 'warning' | 'critical' | 'maintenance'
 *   metrics: {
 *     cpu:     number   — 0-100 (%)
 *     mem:     number   — 0-100 (%)
 *     disk:    number   — 0-100 (%)
 *     net:     number   — 0-1000 (Mbps)
 *   }
 *   uptime:    number   — hours since last restart
 *   addedAt:   number   — Unix timestamp
 * }
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

// =============================================================
// 1. CONSTANTS & THRESHOLDS
// =============================================================

const STORAGE_KEY = 'serverguard_servers';

/** Alert thresholds for each metric */
const THRESHOLDS = {
  cpu:  { warning: 70, critical: 85 },
  mem:  { warning: 75, critical: 90 },
  disk: { warning: 75, critical: 90 },
  net:  { warning: 600, critical: 800 }, // Mbps
};

const METRIC_TICK_MS  = 2000;  // How often live metrics update
const TOAST_DURATION  = 3500;  // ms before toast disappears

// Role-specific icon class lookup
const ROLE_ICONS = {
  Web:     'fa-globe',
  DB:      'fa-database',
  Cache:   'fa-bolt',
  Worker:  'fa-gear',
  Gateway: 'fa-route',
  Storage: 'fa-box-archive',
};

// =============================================================
// 2. APPLICATION STATE
// =============================================================

/** @type {Array<Object>} Master server list */
let servers = [];

/** Current filter: 'all' | 'healthy' | 'warning' | 'critical' | 'maintenance' */
let currentFilter = 'all';

/** ID of the server being edited in modal (null = add mode) */
let editingServerId = null;

/** ID of the server pending deletion confirmation */
let pendingDeleteId = null;

/** setInterval handle for the live metrics tick */
let metricsInterval = null;

// =============================================================
// 3. DOM REFERENCES
// =============================================================

const serverGrid        = document.getElementById('server-grid');
const emptyState        = document.getElementById('empty-state');
const filterBar         = document.getElementById('filter-bar');
const alertSection      = document.getElementById('alert-section');
const alertList         = document.getElementById('alert-list');
const globalStatusBadge = document.getElementById('global-status-badge');
const globalStatusText  = document.getElementById('global-status-text');
const liveClock         = document.getElementById('live-clock');
const metricsServerName = document.getElementById('metrics-server-name');
const toastContainer    = document.getElementById('toast-container');

// Top metric card elements
const metricEls = {
  cpu:  { val: document.getElementById('val-cpu'),  bar: document.getElementById('bar-cpu'),  badge: document.getElementById('badge-cpu'),  card: document.getElementById('card-cpu')  },
  mem:  { val: document.getElementById('val-mem'),  bar: document.getElementById('bar-mem'),  badge: document.getElementById('badge-mem'),  card: document.getElementById('card-mem')  },
  disk: { val: document.getElementById('val-disk'), bar: document.getElementById('bar-disk'), badge: document.getElementById('badge-disk'), card: document.getElementById('card-disk') },
  net:  { val: document.getElementById('val-net'),  bar: document.getElementById('bar-net'),  badge: document.getElementById('badge-net'),  card: document.getElementById('card-net')  },
};

// Modal elements
const serverModal    = document.getElementById('server-modal');
const serverForm     = document.getElementById('server-form');
const modalServerId  = document.getElementById('modal-server-id');
const modalTitle     = document.getElementById('modal-title');
const inputName      = document.getElementById('input-name');
const inputIp        = document.getElementById('input-ip');
const inputLocation  = document.getElementById('input-location');
const inputRole      = document.getElementById('input-role');
const formError      = document.getElementById('form-error');
const modalCloseBtn  = document.getElementById('modal-close-btn');
const modalCancelBtn = document.getElementById('modal-cancel-btn');
const modalSubmitIcon = document.getElementById('modal-submit-icon');
const modalSubmitText = document.getElementById('modal-submit-text');

// Confirm delete modal
const confirmModal     = document.getElementById('confirm-modal');
const confirmBody      = document.getElementById('confirm-body');
const confirmDeleteBtn = document.getElementById('confirm-delete-btn');
const confirmCancelBtn = document.getElementById('confirm-cancel-btn');

// Add server buttons (nav + section)
const btnAddServerNav = document.getElementById('btn-add-server-nav');
const btnAddServer    = document.getElementById('btn-add-server');

// =============================================================
// 4. PERSISTENCE HELPERS
// =============================================================

/** Load servers from localStorage into the `servers` array. */
function loadServers() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    servers = stored ? JSON.parse(stored) : [];
  } catch {
    servers = [];
  }
}

/** Persist the current `servers` array to localStorage. */
function saveServers() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(servers));
}

// =============================================================
// 5. DEFAULT SEED DATA
// =============================================================

/**
 * Return a set of seed servers for first-time visitors so the
 * dashboard looks populated out of the box.
 * @returns {Array<Object>}
 */
function buildSeedServers() {
  return [
    { id: 'srv_seed_1', name: 'prod-web-01',   ip: '10.0.1.10', location: 'US-East-1',    role: 'Web',     status: 'healthy',  metrics: { cpu: 42, mem: 55, disk: 38, net: 120 }, uptime: 720,  addedAt: Date.now() },
    { id: 'srv_seed_2', name: 'prod-db-01',    ip: '10.0.1.20', location: 'US-East-1',    role: 'DB',      status: 'warning',  metrics: { cpu: 72, mem: 84, disk: 61, net: 200 }, uptime: 1440, addedAt: Date.now() },
    { id: 'srv_seed_3', name: 'prod-cache-01', ip: '10.0.2.10', location: 'EU-West-1',    role: 'Cache',   status: 'healthy',  metrics: { cpu: 18, mem: 44, disk: 22, net: 80 },  uptime: 2160, addedAt: Date.now() },
    { id: 'srv_seed_4', name: 'prod-api-gw',   ip: '10.0.3.1',  location: 'AP-South-1',   role: 'Gateway', status: 'critical', metrics: { cpu: 91, mem: 88, disk: 45, net: 850 }, uptime: 48,   addedAt: Date.now() },
    { id: 'srv_seed_5', name: 'worker-node-1', ip: '10.0.4.10', location: 'US-West-2',    role: 'Worker',  status: 'healthy',  metrics: { cpu: 30, mem: 60, disk: 50, net: 150 }, uptime: 360,  addedAt: Date.now() },
    { id: 'srv_seed_6', name: 'storage-nas-1', ip: '10.0.5.5',  location: 'EU-Central-1', role: 'Storage', status: 'maintenance', metrics: { cpu: 5, mem: 20, disk: 78, net: 10 }, uptime: 0, addedAt: Date.now() },
  ];
}

// =============================================================
// 6. METRIC HELPERS
// =============================================================

/**
 * Determine the status level of a single metric value.
 * @param {'cpu'|'mem'|'disk'|'net'} key
 * @param {number} value
 * @returns {'healthy'|'warning'|'critical'}
 */
function metricStatus(key, value) {
  const t = THRESHOLDS[key];
  if (value >= t.critical) return 'critical';
  if (value >= t.warning)  return 'warning';
  return 'healthy';
}

/**
 * Derive the overall server status from its metrics.
 * Maintenance mode is preserved — don't override it.
 * @param {Object} server
 * @returns {'healthy'|'warning'|'critical'|'maintenance'}
 */
function deriveServerStatus(server) {
  if (server.status === 'maintenance') return 'maintenance';
  const { cpu, mem, disk, net } = server.metrics;
  const statuses = [
    metricStatus('cpu',  cpu),
    metricStatus('mem',  mem),
    metricStatus('disk', disk),
    metricStatus('net',  net),
  ];
  if (statuses.includes('critical')) return 'critical';
  if (statuses.includes('warning'))  return 'warning';
  return 'healthy';
}

/**
 * Softly nudge a metric value with random walk simulation.
 * Keeps the value within [min, max].
 * @param {number} current
 * @param {number} min
 * @param {number} max
 * @param {number} volatility - max change per tick
 * @returns {number}
 */
function simulateMetric(current, min, max, volatility) {
  const delta = (Math.random() - 0.48) * volatility; // Slight upward bias for drama
  return Math.min(max, Math.max(min, Math.round((current + delta) * 10) / 10));
}

// =============================================================
// 7. LIVE METRICS TICK
// =============================================================

/**
 * Called every METRIC_TICK_MS. Updates each non-maintenance server's
 * metrics, re-derives its status, then refreshes the UI.
 */
function tickMetrics() {
  let changed = false;

  servers.forEach(server => {
    if (server.status === 'maintenance') return;

    // Simulate metric drift
    server.metrics.cpu  = simulateMetric(server.metrics.cpu,  0,   100,  8);
    server.metrics.mem  = simulateMetric(server.metrics.mem,  0,   100,  5);
    server.metrics.disk = simulateMetric(server.metrics.disk, 0,   100,  2);
    server.metrics.net  = simulateMetric(server.metrics.net,  0,   1000, 50);

    // Increment uptime by tick interval (in seconds)
    server.uptime += METRIC_TICK_MS / 3600000;

    // Re-derive overall status
    const newStatus = deriveServerStatus(server);
    if (newStatus !== server.status) {
      server.status = newStatus;
    }
    changed = true;
  });

  if (changed) {
    saveServers();
    updateTopMetrics();
    updateAlerts();
    updateGlobalStatus();
    refreshServerCards(); // Update mini bars & badges without full re-render
  }
}

/**
 * Compute fleet averages and update the top 4 metric cards.
 */
function updateTopMetrics() {
  const active = servers.filter(s => s.status !== 'maintenance');
  if (active.length === 0) {
    ['cpu', 'mem', 'disk', 'net'].forEach(k => {
      setMetricCard(k, '--', 0, 'healthy');
    });
    metricsServerName.textContent = 'No Active Servers';
    return;
  }

  const avg = (key) => Math.round(active.reduce((s, srv) => s + srv.metrics[key], 0) / active.length);
  const cpuAvg  = avg('cpu');
  const memAvg  = avg('mem');
  const diskAvg = avg('disk');
  const netAvg  = avg('net');

  setMetricCard('cpu',  cpuAvg,  cpuAvg,  metricStatus('cpu',  cpuAvg));
  setMetricCard('mem',  memAvg,  memAvg,  metricStatus('mem',  memAvg));
  setMetricCard('disk', diskAvg, diskAvg, metricStatus('disk', diskAvg));
  // Network: express as Mbps value, bar width is percentage of 1000
  setMetricCard('net',  netAvg,  (netAvg / 10), metricStatus('net', netAvg), ' Mbps');

  metricsServerName.textContent = `Fleet Overview (${active.length} active)`;
}

/**
 * Update a single top metric card.
 * @param {'cpu'|'mem'|'disk'|'net'} key
 * @param {number} value         — displayed number
 * @param {number} barPct        — progress bar fill (0-100)
 * @param {'healthy'|'warning'|'critical'} status
 * @param {string} [unit='%']    — unit suffix
 */
function setMetricCard(key, value, barPct, status, unit = '%') {
  const el = metricEls[key];

  // Value display (preserve the unit span already in HTML)
  const unitSpan = el.val.querySelector('span');
  el.val.firstChild.textContent = value === '--' ? '--' : value;
  if (unitSpan && unit !== '%') unitSpan.textContent = unit;

  // Progress bar width
  el.bar.style.width = `${barPct}%`;

  // Colour the bar by status
  el.bar.className = 'progress-bar ' + {
    cpu:  { healthy: 'bg-accent',    warning: 'bg-yellow-400', critical: 'bg-red-500' },
    mem:  { healthy: 'bg-purple-500', warning: 'bg-yellow-400', critical: 'bg-red-500' },
    disk: { healthy: 'bg-amber-400', warning: 'bg-yellow-400', critical: 'bg-red-500' },
    net:  { healthy: 'bg-teal-400',  warning: 'bg-yellow-400', critical: 'bg-red-500' },
  }[key][status] || 'bg-slate-500';

  // Badge text & class
  el.badge.textContent = { healthy: 'OK', warning: 'WARN', critical: 'CRIT' }[status] || 'OK';
  el.badge.className = 'status-badge ' + { healthy: 'badge-healthy', warning: 'badge-warning', critical: 'badge-critical' }[status];

  // Card glow
  el.card.classList.remove('state-warning', 'state-critical');
  if (status === 'critical') el.card.classList.add('state-critical');
  if (status === 'warning')  el.card.classList.add('state-warning');
}

// =============================================================
// 8. ALERT SYSTEM
// =============================================================

/**
 * Rebuild the active alerts panel based on current server states.
 * An alert is generated for any server whose status is warning or critical.
 */
function updateAlerts() {
  const alerts = [];

  servers.forEach(server => {
    if (server.status === 'maintenance') return;
    const { cpu, mem, disk, net } = server.metrics;

    if (metricStatus('cpu',  cpu)  === 'critical') alerts.push({ severity: 'critical', server: server.name, metric: 'CPU',     value: `${cpu}%`,     threshold: `${THRESHOLDS.cpu.critical}%` });
    else if (metricStatus('cpu',  cpu)  === 'warning')  alerts.push({ severity: 'warning',  server: server.name, metric: 'CPU',     value: `${cpu}%`,     threshold: `${THRESHOLDS.cpu.warning}%` });

    if (metricStatus('mem',  mem)  === 'critical') alerts.push({ severity: 'critical', server: server.name, metric: 'Memory', value: `${mem}%`,     threshold: `${THRESHOLDS.mem.critical}%` });
    else if (metricStatus('mem',  mem)  === 'warning')  alerts.push({ severity: 'warning',  server: server.name, metric: 'Memory', value: `${mem}%`,     threshold: `${THRESHOLDS.mem.warning}%` });

    if (metricStatus('disk', disk) === 'critical') alerts.push({ severity: 'critical', server: server.name, metric: 'Disk',   value: `${disk}%`,    threshold: `${THRESHOLDS.disk.critical}%` });
    else if (metricStatus('disk', disk) === 'warning')  alerts.push({ severity: 'warning',  server: server.name, metric: 'Disk',   value: `${disk}%`,    threshold: `${THRESHOLDS.disk.warning}%` });

    if (metricStatus('net',  net)  === 'critical') alerts.push({ severity: 'critical', server: server.name, metric: 'Network', value: `${net} Mbps`, threshold: `${THRESHOLDS.net.critical} Mbps` });
    else if (metricStatus('net',  net)  === 'warning')  alerts.push({ severity: 'warning',  server: server.name, metric: 'Network', value: `${net} Mbps`, threshold: `${THRESHOLDS.net.warning} Mbps` });
  });

  if (alerts.length === 0) {
    alertSection.classList.add('hidden');
    return;
  }

  alertSection.classList.remove('hidden');
  alertList.innerHTML = alerts.map(a => `
    <div class="alert-item alert-${a.severity}">
      <i class="fa-solid ${a.severity === 'critical' ? 'fa-circle-exclamation' : 'fa-triangle-exclamation'} flex-shrink-0"></i>
      <span>
        <strong>${escapeHtml(a.server)}</strong> —
        ${a.metric} at <strong>${a.value}</strong>
        (threshold: ${a.threshold})
      </span>
      <span class="ml-auto status-badge ${a.severity === 'critical' ? 'badge-critical' : 'badge-warning'}">${a.severity.toUpperCase()}</span>
    </div>
  `).join('');
}

/**
 * Update the global header status badge based on worst server status.
 */
function updateGlobalStatus() {
  const hasCritical    = servers.some(s => s.status === 'critical');
  const hasWarning     = servers.some(s => s.status === 'warning');
  const hasMaintenance = servers.some(s => s.status === 'maintenance');

  globalStatusBadge.className = globalStatusBadge.className
    .replace(/bg-\S+|text-\S+|border-\S+/g, '');

  if (hasCritical) {
    globalStatusBadge.className = 'hidden md:flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-crit/10 text-crit border border-crit/30 transition-colors duration-300';
    globalStatusText.textContent = 'Critical Alerts Active';
    globalStatusBadge.querySelector('.pulse-dot').className = 'pulse-dot bg-crit';
  } else if (hasWarning) {
    globalStatusBadge.className = 'hidden md:flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-warn/10 text-warn border border-warn/30 transition-colors duration-300';
    globalStatusText.textContent = 'Warnings Detected';
    globalStatusBadge.querySelector('.pulse-dot').className = 'pulse-dot bg-warn';
  } else if (hasMaintenance && !hasCritical && !hasWarning) {
    globalStatusBadge.className = 'hidden md:flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-gray-700/50 text-gray-400 border border-gray-600/30 transition-colors duration-300';
    globalStatusText.textContent = 'Maintenance in Progress';
    globalStatusBadge.querySelector('.pulse-dot').className = 'pulse-dot bg-gray-400';
  } else {
    globalStatusBadge.className = 'hidden md:flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-healthy/10 text-healthy border border-healthy/30 transition-colors duration-300';
    globalStatusText.textContent = 'All Systems Healthy';
    globalStatusBadge.querySelector('.pulse-dot').className = 'pulse-dot bg-healthy';
  }
}

// =============================================================
// 9. SERVER CRUD
// =============================================================

/**
 * Generate a unique server ID.
 * @returns {string}
 */
function genId() {
  return `srv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Generate plausible initial metrics for a brand new server.
 * @returns {Object}
 */
function freshMetrics() {
  return {
    cpu:  Math.floor(Math.random() * 50) + 10,
    mem:  Math.floor(Math.random() * 50) + 20,
    disk: Math.floor(Math.random() * 60) + 10,
    net:  Math.floor(Math.random() * 300) + 20,
  };
}

/**
 * Add a new server to the fleet.
 * @param {{name:string, ip:string, location:string, role:string}} data
 */
function addServer(data) {
  const metrics = freshMetrics();
  const server = {
    id:       genId(),
    name:     data.name.trim(),
    ip:       data.ip.trim(),
    location: data.location.trim() || 'Unknown',
    role:     data.role,
    status:   'healthy',
    metrics,
    uptime:   0,
    addedAt:  Date.now(),
  };
  server.status = deriveServerStatus(server);
  servers.unshift(server);
  saveServers();
  renderAll();
  showToast(`Server <strong>${escapeHtml(server.name)}</strong> added to monitoring.`, 'success');
}

/**
 * Update an existing server's editable fields.
 * @param {string} id
 * @param {{name:string, ip:string, location:string, role:string}} data
 */
function updateServer(id, data) {
  const server = servers.find(s => s.id === id);
  if (!server) return;
  server.name     = data.name.trim();
  server.ip       = data.ip.trim();
  server.location = data.location.trim() || 'Unknown';
  server.role     = data.role;
  saveServers();
  renderAll();
  showToast(`Server <strong>${escapeHtml(server.name)}</strong> updated.`, 'info');
}

/**
 * Permanently remove a server from monitoring.
 * @param {string} id
 */
function deleteServer(id) {
  const server = servers.find(s => s.id === id);
  servers = servers.filter(s => s.id !== id);
  saveServers();
  renderAll();
  if (server) showToast(`Server <strong>${escapeHtml(server.name)}</strong> removed.`, 'error');
}

/**
 * Toggle a server between its current status and 'maintenance'.
 * @param {string} id
 */
function toggleMaintenance(id) {
  const server = servers.find(s => s.id === id);
  if (!server) return;

  if (server.status === 'maintenance') {
    // Re-derive status from current metrics
    server.status = deriveServerStatus({ ...server, status: 'healthy' });
    showToast(`<strong>${escapeHtml(server.name)}</strong> taken out of maintenance.`, 'success');
  } else {
    server.status = 'maintenance';
    showToast(`<strong>${escapeHtml(server.name)}</strong> set to maintenance mode.`, 'warn');
  }
  saveServers();
  renderAll();
}

/**
 * Simulate a service restart for the given server.
 * Resets metrics to low values and sets status to healthy after a brief delay.
 * @param {string} id
 * @param {HTMLElement} btnEl — the button element (for spinner feedback)
 */
function restartService(id, btnEl) {
  const server = servers.find(s => s.id === id);
  if (!server || server.status === 'maintenance') return;

  // Visual feedback on button
  const origContent = btnEl.innerHTML;
  btnEl.innerHTML = `<i class="fa-solid fa-rotate spinning"></i> Restarting…`;
  btnEl.disabled  = true;

  showToast(`Restarting <strong>${escapeHtml(server.name)}</strong>…`, 'info');

  setTimeout(() => {
    server.metrics.cpu  = Math.floor(Math.random() * 25) + 5;
    server.metrics.mem  = Math.floor(Math.random() * 30) + 20;
    server.metrics.net  = Math.floor(Math.random() * 100) + 10;
    server.uptime       = 0;
    server.status       = deriveServerStatus(server);
    saveServers();
    renderAll();
    showToast(`<strong>${escapeHtml(server.name)}</strong> restarted successfully.`, 'success');
  }, 1800);
}

// =============================================================
// 10. RENDERING
// =============================================================

/**
 * Full re-render: updates counter, runs filter, rebuilds grid, refreshes top metrics.
 */
function renderAll() {
  const filtered = getFilteredServers();

  // Update filter tab counts
  const countByStatus = { all: servers.length, healthy: 0, warning: 0, critical: 0, maintenance: 0 };
  servers.forEach(s => { if (countByStatus[s.status] !== undefined) countByStatus[s.status]++; });
  ['all', 'healthy', 'warning', 'critical', 'maintenance'].forEach(key => {
    const el = document.getElementById('count-' + key);
    if (el) el.textContent = countByStatus[key] > 0 ? `(${countByStatus[key]})` : '';
  });

  // Grid
  serverGrid.innerHTML = '';
  if (filtered.length === 0) {
    emptyState.classList.remove('hidden');
  } else {
    emptyState.classList.add('hidden');
    filtered.forEach(server => serverGrid.appendChild(createServerCard(server)));
  }

  updateTopMetrics();
  updateAlerts();
  updateGlobalStatus();
}

/**
 * Lightweight update: refresh only the mini metric bars & status badges
 * within existing server cards (avoids full DOM rebuild on every tick).
 */
function refreshServerCards() {
  servers.forEach(server => {
    const card = document.querySelector(`[data-id="${server.id}"]`);
    if (!card) return;

    // Update status class & left border colour
    card.className = card.className.replace(/status-\w+/g, '');
    card.classList.add(`status-${server.status}`);

    // Badge
    const badge = card.querySelector('.server-status-badge');
    if (badge) {
      badge.textContent  = capitalise(server.status);
      badge.className    = `status-badge server-status-badge badge-${server.status}`;
    }

    // Mini bars
    updateMiniBar(card, 'cpu',  server.metrics.cpu,  server.metrics.cpu);
    updateMiniBar(card, 'mem',  server.metrics.mem,  server.metrics.mem);
    updateMiniBar(card, 'disk', server.metrics.disk, server.metrics.disk);
    updateMiniBar(card, 'net',  server.metrics.net,  (server.metrics.net / 10));
  });
}

/**
 * Update a single mini metric bar inside a server card.
 * @param {HTMLElement} card
 * @param {string}  key     — metric name
 * @param {number}  value   — displayed value
 * @param {number}  barPct  — bar width percentage
 */
function updateMiniBar(card, key, value, barPct) {
  const bar = card.querySelector(`[data-mini-bar="${key}"]`);
  const val = card.querySelector(`[data-mini-val="${key}"]`);
  if (!bar || !val) return;

  bar.style.width = `${barPct}%`;
  val.textContent = key === 'net' ? `${value}M` : `${Math.round(value)}%`;

  // Colour the bar
  const status = metricStatus(key, value);
  bar.className = 'mini-bar ' + { healthy: getHealthyBarColour(key), warning: 'bg-yellow-400', critical: 'bg-red-500' }[status];
}

/** Default bar colour when healthy, keyed by metric */
function getHealthyBarColour(key) {
  return { cpu: 'bg-blue-400', mem: 'bg-purple-400', disk: 'bg-amber-400', net: 'bg-teal-400' }[key] || 'bg-slate-400';
}

/**
 * Build and return a server card DOM element.
 * @param {Object} server
 * @returns {HTMLElement}
 */
function createServerCard(server) {
  const div = document.createElement('div');
  div.className = `server-card status-${server.status}`;
  div.dataset.id = server.id;

  const roleIcon = ROLE_ICONS[server.role] || 'fa-server';
  const uptime   = formatUptime(server.uptime);
  const isMaint  = server.status === 'maintenance';

  div.innerHTML = `
    <!-- Card header -->
    <div class="flex items-start justify-between gap-2 pl-2">
      <div class="flex items-center gap-2 min-w-0">
        <div class="w-7 h-7 rounded-md bg-slate-700 flex items-center justify-center flex-shrink-0">
          <i class="fa-solid ${roleIcon} text-xs text-slate-300"></i>
        </div>
        <div class="min-w-0">
          <p class="font-semibold text-sm text-white truncate">${escapeHtml(server.name)}</p>
          <p class="text-[10px] text-slate-500 truncate">${escapeHtml(server.ip)} · ${escapeHtml(server.location)}</p>
        </div>
      </div>
      <span class="status-badge server-status-badge badge-${server.status} flex-shrink-0 mt-0.5">
        ${capitalise(server.status)}
      </span>
    </div>

    <!-- Mini metrics -->
    ${isMaint ? '<p class="text-xs text-slate-500 pl-2 italic">Server in maintenance mode.</p>' : `
    <div class="flex flex-col gap-1 pl-2">
      ${buildMiniMetric('cpu',  server.metrics.cpu,  server.metrics.cpu,   'CPU')}
      ${buildMiniMetric('mem',  server.metrics.mem,  server.metrics.mem,   'MEM')}
      ${buildMiniMetric('disk', server.metrics.disk, server.metrics.disk,  'DISK')}
      ${buildMiniMetric('net',  server.metrics.net,  server.metrics.net / 10, 'NET', server.metrics.net + 'M')}
    </div>
    `}

    <!-- Footer: uptime + actions -->
    <div class="flex items-center justify-between gap-2 pl-2 pt-1 border-t border-slate-700/50">
      <span class="text-[10px] text-slate-500">
        <i class="fa-solid fa-clock mr-1 opacity-50"></i>Up: ${uptime}
      </span>
      <div class="card-actions">
        <button class="card-btn btn-edit"
                data-action="edit" data-id="${server.id}"
                title="Edit server">
          <i class="fa-solid fa-pen-to-square text-[10px] pointer-events-none"></i> Edit
        </button>
        <button class="card-btn btn-maintenance"
                data-action="maintenance" data-id="${server.id}"
                title="${isMaint ? 'Exit maintenance' : 'Enable maintenance'}">
          <i class="fa-solid ${isMaint ? 'fa-play' : 'fa-wrench'} text-[10px] pointer-events-none"></i>
          ${isMaint ? 'Resume' : 'Maint.'}
        </button>
        ${!isMaint ? `
        <button class="card-btn btn-restart"
                data-action="restart" data-id="${server.id}"
                title="Restart service">
          <i class="fa-solid fa-rotate text-[10px] pointer-events-none"></i> Restart
        </button>` : ''}
        <button class="card-btn btn-delete"
                data-action="delete" data-id="${server.id}"
                title="Remove server">
          <i class="fa-solid fa-trash text-[10px] pointer-events-none"></i>
        </button>
      </div>
    </div>
  `;

  return div;
}

/**
 * Build the HTML string for one mini metric row inside a server card.
 * @param {string} key
 * @param {number} rawValue   — used for status colour
 * @param {number} barPct     — 0-100 bar fill
 * @param {string} label
 * @param {string} [display]  — optional override for displayed text
 * @returns {string}
 */
function buildMiniMetric(key, rawValue, barPct, label, display) {
  const status    = metricStatus(key, rawValue);
  const barColour = { healthy: getHealthyBarColour(key), warning: 'bg-yellow-400', critical: 'bg-red-500' }[status];
  const valText   = display !== undefined ? display : `${Math.round(rawValue)}%`;
  return `
    <div class="mini-metric">
      <span class="mini-label">${label}</span>
      <div class="mini-track">
        <div class="mini-bar ${barColour}" data-mini-bar="${key}" style="width:${barPct}%"></div>
      </div>
      <span class="mini-val" data-mini-val="${key}">${valText}</span>
    </div>
  `;
}

// =============================================================
// 11. FILTER
// =============================================================

/**
 * Return the filtered subset of servers based on currentFilter.
 * @returns {Array<Object>}
 */
function getFilteredServers() {
  if (currentFilter === 'all') return servers;
  return servers.filter(s => s.status === currentFilter);
}

// =============================================================
// 12. MODALS
// =============================================================

/** Open the add-server modal (blank form). */
function openAddModal() {
  editingServerId     = null;
  modalServerId.value = '';
  serverForm.reset();
  formError.classList.add('hidden');
  modalTitle.textContent      = 'Add New Server';
  modalSubmitIcon.className   = 'fa-solid fa-plus mr-1.5 text-xs';
  modalSubmitText.textContent = 'Add Server';
  serverModal.classList.remove('hidden');
  inputName.focus();
}

/**
 * Open the edit modal pre-filled with the server's current data.
 * @param {string} id
 */
function openEditModal(id) {
  const server = servers.find(s => s.id === id);
  if (!server) return;

  editingServerId     = id;
  modalServerId.value = id;
  inputName.value     = server.name;
  inputIp.value       = server.ip;
  inputLocation.value = server.location;
  inputRole.value     = server.role;
  formError.classList.add('hidden');
  modalTitle.textContent      = 'Edit Server';
  modalSubmitIcon.className   = 'fa-solid fa-floppy-disk mr-1.5 text-xs';
  modalSubmitText.textContent = 'Save Changes';
  serverModal.classList.remove('hidden');
  inputName.focus();
}

/** Close the server modal and reset state. */
function closeServerModal() {
  serverModal.classList.add('hidden');
  serverForm.reset();
  editingServerId = null;
}

/**
 * Show the confirmation dialog before deleting a server.
 * @param {string} id
 */
function showDeleteConfirm(id) {
  const server = servers.find(s => s.id === id);
  if (!server) return;
  pendingDeleteId = id;
  confirmBody.textContent = `"${server.name}" (${server.ip}) will be permanently removed from monitoring.`;
  confirmModal.classList.remove('hidden');
}

/** Close the confirmation modal without deleting. */
function closeConfirmModal() {
  confirmModal.classList.add('hidden');
  pendingDeleteId = null;
}

// =============================================================
// 13. TOAST NOTIFICATIONS
// =============================================================

/**
 * Show a small toast notification.
 * @param {string} message  — HTML string (use escapeHtml for user content)
 * @param {'success'|'error'|'info'|'warn'} type
 */
function showToast(message, type = 'info') {
  const icons = { success: 'fa-circle-check', error: 'fa-circle-xmark', info: 'fa-circle-info', warn: 'fa-triangle-exclamation' };
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <i class="fa-solid ${icons[type]} flex-shrink-0"></i>
    <span>${message}</span>
  `;
  toastContainer.appendChild(toast);

  // Auto-remove after duration
  setTimeout(() => {
    toast.classList.add('toast-hide');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, TOAST_DURATION);
}

// =============================================================
// 14. LIVE CLOCK
// =============================================================

/** Update the header clock every second. */
function startClock() {
  const tick = () => {
    const now = new Date();
    liveClock.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  tick();
  setInterval(tick, 1000);
}

// =============================================================
// 15. UTILITY
// =============================================================

/**
 * Escape user-supplied text for safe insertion into innerHTML.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#039;');
}

/**
 * Capitalise the first letter of a string.
 * @param {string} str
 * @returns {string}
 */
function capitalise(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Format uptime in hours to a readable string.
 * @param {number} hours
 * @returns {string}
 */
function formatUptime(hours) {
  if (hours < 0.017) return '< 1m';    // less than ~1 minute
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${Math.floor(hours)}h ${Math.round((hours % 1) * 60)}m`;
  const d = Math.floor(hours / 24);
  const h = Math.floor(hours % 24);
  return `${d}d ${h}h`;
}

/**
 * Validate the add/edit server form.
 * @returns {boolean}
 */
function validateForm() {
  const name = inputName.value.trim();
  const ip   = inputIp.value.trim();

  if (!name) {
    showFormError('Server name is required.');
    inputName.focus();
    return false;
  }
  if (!ip) {
    showFormError('IP address is required.');
    inputIp.focus();
    return false;
  }
  // Very basic IP/hostname format check
  const ipPattern = /^[\d.:\w-]+$/;
  if (!ipPattern.test(ip)) {
    showFormError('IP address contains invalid characters.');
    inputIp.focus();
    return false;
  }
  // Duplicate name check (ignore current server when editing)
  const duplicate = servers.find(s => s.name.toLowerCase() === name.toLowerCase() && s.id !== editingServerId);
  if (duplicate) {
    showFormError(`A server named "${name}" already exists.`);
    inputName.focus();
    return false;
  }

  formError.classList.add('hidden');
  return true;
}

/**
 * Display a validation error in the modal.
 * @param {string} msg
 */
function showFormError(msg) {
  formError.textContent = msg;
  formError.classList.remove('hidden');
}

// =============================================================
// 16. EVENT LISTENERS
// =============================================================

// ── Open add modal ──
btnAddServer.addEventListener('click', openAddModal);
btnAddServerNav.addEventListener('click', openAddModal);

// ── Close server modal ──
modalCloseBtn.addEventListener('click', closeServerModal);
modalCancelBtn.addEventListener('click', closeServerModal);
serverModal.addEventListener('click', (e) => {
  if (e.target === serverModal) closeServerModal();
});

// ── Server form submit (add or edit) ──
serverForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!validateForm()) return;

  const data = {
    name:     inputName.value,
    ip:       inputIp.value,
    location: inputLocation.value,
    role:     inputRole.value,
  };

  if (editingServerId) {
    updateServer(editingServerId, data);
  } else {
    addServer(data);
  }
  closeServerModal();
});

// ── Confirm delete modal ──
confirmDeleteBtn.addEventListener('click', () => {
  if (pendingDeleteId) {
    deleteServer(pendingDeleteId);
    pendingDeleteId = null;
  }
  closeConfirmModal();
});
confirmCancelBtn.addEventListener('click', closeConfirmModal);
confirmModal.addEventListener('click', (e) => {
  if (e.target === confirmModal) closeConfirmModal();
});

// ── Filter buttons ──
filterBar.addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;

  filterBar.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active-filter'));
  btn.classList.add('active-filter');

  currentFilter = btn.dataset.filter;
  renderAll();
});

// ── Server grid: event delegation for card actions ──
serverGrid.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const id     = btn.dataset.id;
  const action = btn.dataset.action;

  switch (action) {
    case 'edit':        openEditModal(id);             break;
    case 'delete':      showDeleteConfirm(id);         break;
    case 'maintenance': toggleMaintenance(id);         break;
    case 'restart':     restartService(id, btn);       break;
  }
});

// ── Keyboard: close modals on Escape ──
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!serverModal.classList.contains('hidden'))  closeServerModal();
    if (!confirmModal.classList.contains('hidden')) closeConfirmModal();
  }
});

// =============================================================
// 17. INITIALISE
// =============================================================

/**
 * Bootstrap the application:
 *  1. Load persisted servers (or seed with demo data).
 *  2. Render all UI.
 *  3. Start the live metrics simulation interval.
 *  4. Start the clock.
 */
(function init() {
  loadServers();

  // Seed demo data for first-time visitors
  if (servers.length === 0) {
    servers = buildSeedServers();
    saveServers();
  }

  renderAll();
  startClock();

  // Start live metrics simulation
  metricsInterval = setInterval(tickMetrics, METRIC_TICK_MS);
})();
