const socket = io();

let map, courierMarker, destMarker, routeLine, routeLineTrail, tileLayer, currentTileTheme = '';
let animRoute = null, animIndex = 0, animProgress = 0, animRAF = null, animLastT = 0;
let lastRoute = null;

const TILES = {
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  light: 'https://{s}.basemaps.cartocdn.com/voyager/{z}/{x}/{y}{r}.png',
};

// Car SVG that rotates to face direction of travel
const CAR_SVG = `<svg viewBox="0 0 32 32" width="36" height="36" xmlns="http://www.w3.org/2000/svg">
  <defs><filter id="sh" x="-50%" y="-50%" width="200%" height="200%">
    <feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity="0.4"/>
  </filter></defs>
  <g filter="url(#sh)">
    <path d="M16 2 L26 28 L16 24 L6 28 Z" fill="var(--car-color, #1FBAD6)" stroke="#fff" stroke-width="1.5"/>
    <circle cx="16" cy="14" r="3" fill="#fff" opacity="0.8"/>
  </g>
</svg>`;

function initMap() {
  map = L.map('map', {
    zoomControl: true,
    attributionControl: true,
    tap: true,
    tapTolerance: 15,
    zoomAnimation: true,
    fadeAnimation: true,
    markerZoomAnimation: true,
    inertia: false,
  }).setView([37.7749, -122.4194], 13);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  map.zoomControl.remove();
  tileLayer = L.tileLayer(TILES.dark, {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap &copy; CARTO',
  }).addTo(map);
  currentTileTheme = 'dark';

  // Car marker — rotates via CSS transform on the inner element
  const courierIcon = L.divIcon({
    className: 'courier-car',
    html: `<div class="car-wrap" id="carWrap">${CAR_SVG}</div>`,
    iconSize: [36, 36], iconAnchor: [18, 18],
  });
  courierMarker = L.marker([37.7749, -122.4194], { icon: courierIcon, zIndexOffset: 1000 }).addTo(map);

  destMarker = L.marker([37.7849, -122.4094], {
    icon: L.divIcon({
      className: 'dest-icon',
      html: '<div class="dm-pin"></div>',
      iconSize: [24, 24], iconAnchor: [12, 24],
    }),
  }).addTo(map);

  routeLine = L.polyline([], { color: '#1FBAD6', weight: 5, opacity: 0.6, lineCap: 'round' }).addTo(map);
  routeLineTrail = L.polyline([], { color: '#1FBAD6', weight: 5, opacity: 0.9, lineCap: 'round' }).addTo(map);
}

function applyTiles(theme) {
  if (!map) return;
  const want = theme === 'dark' ? 'dark' : 'light';
  if (want === currentTileTheme) return;
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(TILES[want], {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap &copy; CARTO',
  }).addTo(map);
  currentTileTheme = want;
}

function ensureMap() {
  if (!map) initMap();
}

// ---------- Car animation engine ----------
function startCarAnimation(route, startIndex, speed, color) {
  stopCarAnimation();
  if (!route || route.length < 2) return;
  animRoute = route;
  animIndex = Math.min(startIndex, route.length - 2);
  animProgress = 0;
  animLastT = performance.now();
  const segMs = Math.max(300, (speed || 2000));

  function tick(now) {
    if (!animRoute) return;
    if (animIndex >= animRoute.length - 1) {
      const last = animRoute[animRoute.length - 1];
      courierMarker.setLatLng([last.lat, last.lng]);
      return; // arrived
    }
    const dt = now - animLastT;
    animLastT = now;
    animProgress += dt / segMs;
    while (animProgress >= 1 && animIndex < animRoute.length - 2) {
      animProgress -= 1;
      animIndex++;
    }
    if (animIndex >= animRoute.length - 1) {
      const last = animRoute[animRoute.length - 1];
      courierMarker.setLatLng([last.lat, last.lng]);
      return;
    }
    const p1 = animRoute[animIndex];
    const p2 = animRoute[animIndex + 1];
    const t = Math.min(1, animProgress);
    const lat = p1.lat + (p2.lat - p1.lat) * t;
    const lng = p1.lng + (p2.lng - p1.lng) * t;
    courierMarker.setLatLng([lat, lng]);
    const bearing = calcBearing(p1, p2);
    rotateCar(bearing);
    // Update trail line
    const trail = animRoute.slice(0, animIndex + 1).map(p => [p.lat, p.lng]);
    trail.push([lat, lng]);
    routeLineTrail.setLatLngs(trail);
    routeLineTrail.setStyle({ color: color || '#1FBAD6', opacity: 0.9 });
    animRAF = requestAnimationFrame(tick);
  }
  animRAF = requestAnimationFrame(tick);
}

function stopCarAnimation() {
  if (animRAF) { cancelAnimationFrame(animRAF); animRAF = null; }
}

function calcBearing(p1, p2) {
  const lat1 = p1.lat * Math.PI / 180;
  const lat2 = p2.lat * Math.PI / 180;
  const dLng = (p2.lng - p1.lng) * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  let b = Math.atan2(y, x) * 180 / Math.PI;
  return (b + 360) % 360;
}

function rotateCar(bearing) {
  const wrap = document.getElementById('carWrap');
  if (wrap) {
    wrap.style.transform = `rotate(${Math.round(bearing)}deg)`;
    wrap.style.transition = 'transform 0.4s ease-out';
  }
}

let lastSnapshot = null;

function render(s) {
  if (!s) return;
  lastSnapshot = s;
  // Branding — set on <body> so they win over the theme-class defaults, making the page blend.
  const b = document.body;
  b.style.setProperty('--primary', s.company.primary);
  b.style.setProperty('--accent', s.company.accent);
  if (s.company.surface) b.style.setProperty('--surface', s.company.surface);
  if (s.company.surface2) b.style.setProperty('--surface-2', s.company.surface2);
  if (s.company.border) b.style.setProperty('--border', s.company.border);
  b.style.background = s.company.bg || '';
  b.classList.remove('theme-dark', 'theme-light');
  b.classList.add('theme-' + (s.company.theme || 'light'));
  applyTiles(s.company.theme || 'light');
  document.getElementById('brandLogo').src = s.company.logo;
  document.getElementById('brandName').textContent = s.company.name;
  document.getElementById('footerBrand').textContent = s.company.name;

  // Demo indicator
  const demoPill = document.getElementById('demoPill');
  if (demoPill) demoPill.hidden = !s.trip.demoRunning;

  // Status
  document.getElementById('statusText').textContent = s.trip.status;
  document.getElementById('tripStatus').textContent = s.trip.status;
  document.getElementById('statusMessage').textContent = s.trip.statusMessage;

  // ETA badge (server-provided string; local ticker refreshes it each second)
  updateEtaBadge();
  // store the deadline/eta for the ticker
  etaDeadline = s.trip.etaDeadline || 0;
  etaAuto = s.trip.etaAuto !== false;
  etaMinutesManual = s.trip.etaMinutes || 0;

  // Representative
  if (s.rep) {
    const repOn = s.ui.rep !== false && s.rep.enabled !== false;
    showEl('repBar', repOn);
    if (repOn) {
      document.getElementById('repName').textContent = s.rep.name;
      const av = document.getElementById('repAvatar');
      av.textContent = (s.rep.name || '?').trim().charAt(0).toUpperCase();
      av.style.background = s.company.primary;
      const num = (s.rep.number || '').replace(/[^\d+]/g, '');
      const ext = s.rep.ext ? ` x${s.rep.ext}` : '';
      document.getElementById('repNumber').textContent = (s.rep.number || '—') + ext;
      document.getElementById('repCall').href = num ? 'tel:' + num + (s.rep.ext ? ',,' + s.rep.ext : '') : '#';
    }
  }

  // Courier
  document.getElementById('courierName').textContent = s.courier.name;
  document.getElementById('courierVehicle').textContent = s.courier.vehicle;
  document.getElementById('courierRating').textContent = '★ ' + s.courier.rating;
  const avatar = document.getElementById('courierAvatar');
  avatar.textContent = (s.courier.name || '?').trim().charAt(0).toUpperCase();
  avatar.style.background = s.company.primary;

  // Uber link
  const uber = document.getElementById('uberLink');
  uber.href = s.trip.uberLink;

  // Client
  document.getElementById('trackingId').textContent = s.client.trackingId;
  document.getElementById('trackingId2').textContent = s.client.trackingId;
  document.getElementById('clientName').textContent = s.client.name;
  document.getElementById('clientAddress').textContent = `${s.client.address}, ${s.client.city}`;
  document.getElementById('clientPhone').textContent = s.client.phone;
  document.getElementById('orderItems').textContent = s.order.items;
  document.getElementById('orderNote').textContent = s.order.note || '—';

  // Delivery code
  document.getElementById('deliveryCode').textContent = s.trip.deliveryCode;

  // Call courier link
  const phone = (s.courier.phone || '').replace(/[^\d+]/g, '');
  document.getElementById('callCourier').href = phone ? 'tel:' + phone : '#';

  // Timeline
  renderTimeline(s.trip.flow || []);

  // Progress bar
  const total = (s.trip.flow || []).length;
  const idx = s.trip.flowIndex + 1;
  document.getElementById('progressFill').style.width = total ? (idx / total) * 100 + '%' : '0%';

  // Map
  ensureMap();
  const cp = s.trip.courierPos;
  const dp = s.trip.destinationPos;
  destMarker.setLatLng([dp.lat, dp.lng]);

  // Update car color
  const carWrap = document.getElementById('carWrap');
  if (carWrap) carWrap.style.setProperty('--car-color', s.company.primary);

  // If route changed, start new animation
  const route = s.trip.route;
  const routeKey = route ? route.length + ':' + s.trip.stepIndex + ':' + s.trip.simulating : null;
  if (route && route.length > 1 && routeKey !== lastRoute) {
    lastRoute = routeKey;
    startCarAnimation(route, s.trip.stepIndex, s.trip.simSpeed || 2000, s.company.primary);
  } else if (!route) {
    // No route — just place car at current position
    stopCarAnimation();
    courierMarker.setLatLng([cp.lat, cp.lng]);
    routeLine.setLatLngs([]);
    routeLineTrail.setLatLngs([]);
  }

  // Draw full route line (faded) + trail (solid, traveled portion)
  if (route && route.length > 1) {
    const allLatLngs = route.map(p => [p.lat, p.lng]);
    routeLine.setLatLngs(allLatLngs);
    routeLine.setStyle({ color: s.company.primary, opacity: 0.25 });
    const trailIdx = Math.min(animIndex + 1, route.length);
    const trail = route.slice(0, trailIdx).map(p => [p.lat, p.lng]);
    routeLineTrail.setLatLngs(trail);
    routeLineTrail.setStyle({ color: s.company.primary, opacity: 0.9 });
  }

  // Fit bounds when route changes
  if (route && route.length > 1) {
    const bounds = L.latLngBounds(route.map(p => [p.lat, p.lng]));
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
  } else {
    courierMarker.setLatLng([cp.lat, cp.lng]);
    const bounds = L.latLngBounds([[cp.lat, cp.lng], [dp.lat, dp.lng]]);
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
  }

  // ---------- Section visibility toggles ----------
  const ui = s.ui || {};
  showEl('mapSection', ui.map !== false);
  showEl('etaBadge', ui.eta !== false);
  showEl('timelineSection', ui.timeline !== false);
  showEl('courierCard', ui.courierCard !== false);
  showEl('clientCard', ui.clientCard !== false);
  showEl('orderCard', ui.orderCard !== false);
  showEl('deliveryCodeSection', ui.deliveryCode !== false);
  showEl('instructionsSection', ui.instructions !== false);
  showEl('uberLink', ui.uberLink !== false);
  showEl('callCourier', ui.callCourier !== false);
}

function showEl(id, on) {
  const el = document.getElementById(id);
  if (el) el.hidden = !on;
}

// ---------- ETA countdown ticker ----------
let etaDeadline = 0, etaAuto = true, etaMinutesManual = 0;
function updateEtaBadge() {
  const el = document.getElementById('etaBadge');
  if (!el) return;
  if (lastSnapshot && lastSnapshot.trip && (lastSnapshot.trip.status === 'Arrived' || lastSnapshot.trip.status === 'Delivered')) {
    el.textContent = '0 min'; return;
  }
  if (!etaAuto) { el.textContent = (etaMinutesManual || 0) + ' min'; return; }
  const secs = Math.round((etaDeadline - Date.now()) / 1000);
  if (secs <= 0) { el.textContent = '0 min'; return; }
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  el.textContent = m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`;
}
setInterval(updateEtaBadge, 1000);

// Fetch initial then subscribe
fetch('/api/state').then((r) => r.json()).then(render).catch(() => {});
socket.on('state', render);

// ---------- Timeline ----------
function renderTimeline(flow) {
  const el = document.getElementById('timeline');
  if (!el || !flow || !flow.length) return;
  el.innerHTML = flow.map((step, i) => {
    const cls = ['t-step'];
    if (step.done) cls.push('done');
    if (step.active) cls.push('active');
    return `
      <div class="${cls.join(' ')}">
        <div class="t-marker">
          ${step.done ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M9 16.2l-3.5-3.6L4 14.2 9 19 20 8l-1.5-1.6z"/></svg>' : (step.active ? '<span class="t-pulse"></span>' : '')}
        </div>
        <div class="t-body">
          <div class="t-status">${step.status}</div>
          <div class="t-msg">${step.message}</div>
        </div>
      </div>`;
  }).join('');
}

// ---------- Notification sound on status change ----------
let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.type = 'sine';
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.18, audioCtx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.45);
    o.start();
    o.stop(audioCtx.currentTime + 0.46);
  } catch (e) {}
}
socket.on('statusChange', (d) => {
  beep();
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('Courier update', { body: d.to + (d.message ? ' — ' + d.message : '') });
  }
});
// request notification permission once on first interaction
document.addEventListener('click', function once() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  document.removeEventListener('click', once);
}, { once: true });

// ---------- Admin alert toast ----------
let toastTimer = null;
socket.on('alert', (d) => {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = d.text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 6000);
  beep();
});
