// brandfetch.js — pull a partner brand's logo + color palette directly from their site.
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname);
const LOGOS_DIR = path.join(ROOT, 'public', 'logos');

// Partner sites we work with closely.
const PARTNERS = {
  UPS:   { site: 'https://www.ups.com',               name: 'UPS',                         fallbackPrimary: '#351C15', fallbackLogo: '/logos/ups.svg' },
  FEDEX: { site: 'https://www.fedex.com',             name: 'FedEx',                       fallbackPrimary: '#4D148C', fallbackLogo: '/logos/fedex.svg' },
  BOA:   { site: 'https://www.bankofamerica.com',     name: 'Bank of America',             fallbackPrimary: '#012169', fallbackLogo: '/logos/boa.svg' },
  DHL:   { site: 'https://www.dhl.com',               name: 'DHL Express',                 fallbackPrimary: '#D40511', fallbackLogo: '/logos/dhl.svg' },
  NFCU:  { site: 'https://www.navyfederal.org',       name: 'Navy Federal Credit Union',   fallbackPrimary: '#004B27', fallbackLogo: '/logos/navyfederal.svg' },
  PNC:   { site: 'https://www.pnc.com',               name: 'PNC Bank',                    fallbackPrimary: '#005EB8', fallbackLogo: '/logos/pnc.svg' },
  CHASE: { site: 'https://www.chase.com',             name: 'Chase',                       fallbackPrimary: '#117DC1', fallbackLogo: '/logos/chase.svg' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function attr(tag, name) {
  const m = tag.match(new RegExp(name + '\\s*=\\s*["\']([^"\']+)["\']', 'i'));
  return m ? m[1] : null;
}

// Collect logo candidates from <head> + og:image + JSON-LD, ranked by preference.
function pickLogoCandidates(html, baseUrl) {
  const cands = [];
  const linkRe = /<link\b[^>]*>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const tag = m[0];
    const rel = (attr(tag, 'rel') || '').toLowerCase();
    if (!rel.includes('icon')) continue;
    const href = attr(tag, 'href');
    if (!href) continue;
    const sizes = attr(tag, 'sizes') || '';
    let score = 1;
    if (rel.includes('apple-touch')) score = 5;
    else if (rel.includes('mask')) score = 2;
    else if (sizes.includes('192')) score = 4;
    else if (sizes.includes('180')) score = 4;
    else if (sizes.includes('32')) score = 3;
    if (href.toLowerCase().endsWith('.svg')) score -= 0.5;
    cands.push({ href, score });
  }
  const og = html.match(/<meta\b[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (og) cands.push({ href: og[1], score: 4.5 });
  const og2 = html.match(/<meta\b[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (og2) cands.push({ href: og2[1], score: 4.5 });
  const ld = html.match(/"logo"\s*:\s*"([^"]+)"/i);
  if (ld) cands.push({ href: ld[1], score: 4 });

  const out = cands
    .map((c) => ({ ...c, abs: absUrl(c.href, baseUrl) }))
    .filter((c) => c.abs)
    .sort((a, b) => b.score - a.score);
  return out;
}

function absUrl(href, base) {
  try {
    return new URL(href, base).href;
  } catch (e) {
    return null;
  }
}

function siteName(html, fallback) {
  const og = html.match(/<meta\b[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  if (og && og[1] && og[1].length <= 28) return og[1];
  const og2 = html.match(/<meta\b[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i);
  if (og2 && og2[1] && og2[1].length <= 28) return og2[1];
  const t = html.match(/<title>([^<]{2,80})<\/title>/i);
  if (t && t[1]) {
    const n = t[1].split(/[|–-]/)[0].trim();
    if (n.length <= 28) return n;
  }
  return fallback;
}

// Download an icon image, decode PNG, and find the most saturated dominant color.
async function downloadAndColor(id, url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    let logoPath, color = null;
    let ext = '.png';
    if (ct.includes('svg')) ext = '.svg';
    else if (ct.includes('jpeg') || ct.includes('jpg')) ext = '.jpg';
    else if (ct.includes('ico')) ext = '.ico';
    else if (ct.includes('webp')) ext = '.webp';
    const fname = `live_${id}${ext}`;
    fs.mkdirSync(LOGOS_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOGOS_DIR, fname), buf);
    logoPath = `/logos/${fname}`;
    if (ext === '.png') color = dominantColor(buf);
    return { logoPath, color };
  } finally {
    clearTimeout(t);
  }
}

function dominantColor(buf) {
  try {
    const png = PNG.sync.read(buf);
    const { data } = png;
    const counts = {};
    let best = null, bestScore = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 200) continue;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx > 235 && mn > 228) continue; // near-white background
      if (mx < 40) continue;              // near-black
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      if (sat < 0.12) continue;           // grayish
      const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
      counts[key] = (counts[key] || 0) + 1;
      // area-weighted, saturation as a mild booster — favors the dominant brand color
      const score = counts[key] * (0.5 + sat);
      if (score > bestScore) {
        bestScore = score;
        best = `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
      }
    }
    return best;
  } catch (e) {
    return null;
  }
}

// ---------- color math ----------
function hexToRgb(h) {
  const s = h.replace('#', '');
  const n = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  const v = parseInt(n, 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');
}
function lerp(a, b, t) { return a + (b - a) * t; }
function shade(hex, amt) {
  const { r, g, b } = hexToRgb(hex);
  if (amt >= 0) return rgbToHex(lerp(r, 255, amt), lerp(g, 255, amt), lerp(b, 255, amt));
  const t = -amt;
  return rgbToHex(lerp(r, 0, t), lerp(g, 0, t), lerp(b, 0, t));
}
function withAlpha(hex, a) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

// Build the full palette that makes the page blend from a single brand color.
function buildPalette(primary) {
  const L = luminance(primary);
  const theme = L >= 0.6 ? 'light' : 'dark';
  if (theme === 'dark') {
    const top = shade(primary, -0.28);
    const mid = shade(primary, -0.52);
    const bot = shade(primary, -0.70);
    const bg = `radial-gradient(120% 80% at 50% -10%, ${top} 0%, ${mid} 55%, ${bot} 100%)`;
    return {
      theme, bg,
      accent: shade(primary, 0.24),
      surface: withAlpha(shade(primary, -0.60), 0.78),
      surface2: withAlpha(shade(primary, -0.48), 0.78),
      border: withAlpha(shade(primary, -0.30), 0.45),
    };
  }
  const t1 = shade(primary, 0.93);
  const t2 = shade(primary, 0.82);
  const bg = `radial-gradient(120% 80% at 50% -10%, #ffffff 0%, ${t1} 55%, ${t2} 100%)`;
  return {
    theme, bg,
    accent: shade(primary, -0.25),
    surface: '#ffffff',
    surface2: shade(primary, 0.96),
    border: withAlpha(primary, 0.16),
  };
}

// Fetch a single brand live. Falls back to curated values if the site is unreachable.
async function fetchBrand(id) {
  const p = PARTNERS[id];
  if (!p) throw new Error('Unknown brand id: ' + id);
  const result = { id, name: p.name, logo: p.fallbackLogo, primary: p.fallbackPrimary, site: p.site };
  try {
    const html = await fetchHtml(p.site);
    result.name = siteName(html, p.name) || p.name;
    const cands = pickLogoCandidates(html, p.site);
    let chosen = null;
    for (const c of cands) {
      try {
        const r = await downloadAndColor(id, c.abs);
        if (!chosen) chosen = r; // first usable as fallback
        if (r.logoPath && r.logoPath.endsWith('.png')) { chosen = r; break; } // prefer PNG
      } catch (e) { /* try next candidate */ }
    }
    if (chosen) {
      if (chosen.logoPath) result.logo = chosen.logoPath;
      if (chosen.color) result.primary = chosen.color;
    }
  } catch (e) {
    // site unreachable — keep curated fallbacks
  }
  const palette = buildPalette(result.primary);
  return { ...result, ...palette };
}

async function fetchAllBrands() {
  const ids = Object.keys(PARTNERS);
  const out = [];
  for (const id of ids) {
    try {
      const b = await fetchBrand(id);
      out.push(b);
      console.log(`  ${id.padEnd(6)} ${b.name.padEnd(28)} primary=${b.primary} theme=${b.theme} logo=${b.logo}`);
    } catch (e) {
      console.log(`  ${id} FAILED: ${e.message}`);
    }
  }
  return out;
}

module.exports = { fetchBrand, fetchAllBrands, buildPalette, PARTNERS };
