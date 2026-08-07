const socket = io();
const $ = (id) => document.getElementById(id);
let currentState = null;
const SECTIONS = ['map','eta','timeline','courierCard','clientCard','orderCard','deliveryCode','instructions','uberLink','callCourier','rep'];

async function api(body) {
  const r = await fetch('/api/admin/update', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

function toast(msg, isErr) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast show' + (isErr ? ' error' : '');
  clearTimeout(window.__tt);
  window.__tt = setTimeout(() => t.className = 'toast', 2200);
}

function render(s) {
  if (!s) return;
  currentState = s;
  // Company grid
  fetch('/api/companies').then(r => r.json()).then(list => {
    const g = $('companyGrid'); g.innerHTML = '';
    list.forEach(c => {
      const d = document.createElement('div');
      d.className = 'company-chip' + (s.company.id === c.id ? ' active' : '');
      d.innerHTML = `<img src="${c.logo}" alt="${c.id}" onerror="this.src='/favicon.svg'"><div class="nm">${c.name}</div>`;
      d.onclick = () => api({ action: 'setCompany', id: c.id }).then(() => toast('Brand: ' + c.name));
      g.appendChild(d);
    });
  });
  $('brandName').value = s.company.name;
  $('brandPrimary').value = normHex(s.company.primary);
  $('brandAccent').value = normHex(s.company.accent);
  $('brandTheme').value = s.company.theme;

  // Client
  $('cName').value = s.client.name; $('cAddress').value = s.client.address;
  $('cCity').value = s.client.city; $('cPhone').value = s.client.phone;
  // Courier
  $('crName').value = s.courier.name; $('crVehicle').value = s.courier.vehicle;
  $('crRating').value = s.courier.rating; $('crPhone').value = s.courier.phone;
  // Rep
  $('rName').value = s.rep.name; $('rNumber').value = s.rep.number; $('rExt').value = s.rep.ext;
  // Order
  $('oItems').value = s.order.items; $('oNote').value = s.order.note;
  // Status
  $('statusMsg').value = s.trip.statusMessage;
  renderFlow(s.trip.flow || [], s.trip.flowIndex);
  $('uberUrl').value = s.trip.uberLink;

  // Toggles
  const tg = $('toggles'); tg.innerHTML = '';
  SECTIONS.forEach(k => {
    const row = document.createElement('div'); row.className = 'toggle-row';
    row.innerHTML = `<span class="name">${k}</span><div class="switch${s.ui[k] !== false ? ' on' : ''}"></div>`;
    row.querySelector('.switch').onclick = () => {
      api({ action: 'toggleUI', section: k }).then(() => toast(k + ' toggled'));
    };
    tg.appendChild(row);
  });
}

function normHex(h) {
  if (!h || h.startsWith('rgb')) return '#1FBAD6';
  let s = h.replace('#','');
  if (s.length === 3) s = s.split('').map(c=>c+c).join('');
  return '#' + s.slice(0,6);
}

function renderFlow(flow, idx) {
  const el = $('statusFlow'); el.innerHTML = '';
  flow.forEach((f, i) => {
    const c = document.createElement('span');
    c.className = 'flow-step' + (i < idx ? ' done' : '') + (i === idx ? ' active' : '');
    c.textContent = f.status; c.onclick = () => api({ action: 'setStatusN', n: i+1 }).then(() => toast('Status set'));
    el.appendChild(c);
  });
}

// ---- bind buttons ----
$('saveClient').onclick = () => api({ action:'setClient', name:$('cName').value, address:$('cAddress').value, city:$('cCity').value, phone:$('cPhone').value }).then(r => toast('Client saved'));
$('saveCourier').onclick = () => api({ action:'setCourier', name:$('crName').value, vehicle:$('crVehicle').value, rating:$('crRating').value, phone:$('crPhone').value }).then(r => toast('Courier saved'));
$('saveRep').onclick = () => api({ action:'setRep', name:$('rName').value, number:$('rNumber').value, ext:$('rExt').value }).then(r => toast('Rep saved'));
$('saveOrder').onclick = () => api({ action:'setOrder', items:$('oItems').value, note:$('oNote').value }).then(r => toast('Order saved'));
$('saveStatus').onclick = () => api({ action:'setStatus', message:$('statusMsg').value }).then(r => toast('Status saved'));
$('saveUber').onclick = () => api({ action:'setUber', url:$('uberUrl').value }).then(r => toast('Uber link saved'));
$('advanceStatus').onclick = () => api({ action:'advanceStatus' }).then(r => toast('Status advanced'));
$('setEta').onclick = () => api({ action:'setETA', minutes:$('etaMin').value }).then(r => toast('ETA set'));
$('etaAuto').onclick = () => api({ action:'etaAuto' }).then(r => toast('ETA auto'));
$('applyBrand').onclick = () => api({ action:'setBranding', name:$('brandName').value, theme:$('brandTheme').value, primary:$('brandPrimary').value, accent:$('brandAccent').value }).then(r => toast('Branding applied'));
$('brandTheme').onchange = (e) => api({ action:'setBranding', theme:e.target.value }).then(r => toast('Theme: '+e.target.value));
$('doMove').onclick = async () => {
  const r = await api({ action:'moveAddress', address:$('moveAddr').value });
  toast(r.ok ? 'Moved: ' + (r.display||'') : 'Move failed', !r.ok);
};
$('doRoute').onclick = async () => {
  const r = await api({ action:'routeAddress', address:$('routeAddr').value });
  toast(r.ok ? 'Route set: ' + (r.display||'') : 'Route failed', !r.ok);
};
$('simSpeed').oninput = (e) => { $('speedLabel').textContent = (e.target.value/1000).toFixed(1)+'s'; };
$('simSpeed').onchange = (e) => api({ action:'setSimSpeed', speed: parseInt(e.target.value) }).then(r => toast('Speed set'));
$('simToggle').onclick = (e) => {
  const on = e.target.textContent.includes('Pause');
  api({ action:'simulate', on }).then(() => { e.target.textContent = on ? '▶ Resume' : '⏸ Pause sim'; toast(on?'Paused':'Resumed'); });
};
$('simStep').onclick = () => api({ action:'step' }).then(r => toast('Stepped'));
$('runDemo').onclick = () => api({ action:'runDemo' }).then(r => toast('Demo started'));
$('stopDemo').onclick = () => api({ action:'stopDemo' }).then(r => toast('Demo stopped'));
$('newOrder').onclick = () => api({ action:'newOrder' }).then(r => toast('New order'));
$('sendAlert').onclick = () => api({ action:'alert', text:$('alertText').value }).then(r => toast('Alert pushed'));
document.querySelectorAll('[data-preset]').forEach(b => {
  b.onclick = () => api({ action:'uiPreset', preset:b.dataset.preset }).then(r => toast('Preset: '+b.dataset.preset));
});

socket.on('state', render);
fetch('/api/state').then(r => r.json()).then(render);
