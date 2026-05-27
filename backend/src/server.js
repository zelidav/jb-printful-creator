import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { Storage } from '@google-cloud/storage';
import { pf } from './printful.js';
import { memo } from './cache.js';
import { classifyPlacements, buildShoeFiles, fitToCanvas, dimsFromPrintfiles, getPrimaryColor, solidWithLogo, compositeLogo, imageDims, tileToCanvas, dominantColors, compositeText } from './wrap.js';
import { regenerateArt } from './aiart.js';
import { createJob, getJob, emit, subscribe } from './jobs.js';
import { attachShopRoutes } from './shop.js';
import { attachTemplateRoutes } from './templates.js';

const PORT = parseInt(process.env.PORT || '8080');
const TOKEN = process.env.PRINTFUL_TOKEN;
const STORE_ID = process.env.STORE_ID;
const APP_PASSWORD = process.env.APP_PASSWORD;
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN; // for AI design notes (google/nano-banana)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const UPLOAD_BUCKET = process.env.UPLOAD_BUCKET || 'jb-printful-creator-uploads';

const gcs = new Storage();
const uploadBucket = gcs.bucket(UPLOAD_BUCKET);

if (!TOKEN) { console.error('PRINTFUL_TOKEN missing'); process.exit(1); }
if (!APP_PASSWORD) { console.error('APP_PASSWORD missing'); process.exit(1); }

const printful = pf({ token: TOKEN, storeId: STORE_ID });
const app = express();

app.use(cors({ origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN, credentials: false }));
app.use(express.json({ limit: '4mb' }));

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  // Approve/deny links open from email — no password header possible
  if (req.path.startsWith('/api/shop/approve/') || req.path.startsWith('/api/shop/deny/')) return next();
  const pass = req.header('x-jb-pass');
  if (pass !== APP_PASSWORD) return res.status(401).json({ error: 'unauthorized' });
  next();
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Techniques that accept a raster design (our patterns/logos). EMBROIDERY/KNITWEAR don't,
// so products that ONLY support those can't be created from artwork — hide them from the catalog.
const PRINTABLE_TECHNIQUES = new Set(['SUBLIMATION', 'DTFILM', 'UV', 'CUT-SEW', 'DIRECT-TO-FABRIC', 'DTG', 'DIGITAL']);
function isEmbroideryOnlyProduct(p) {
  const techs = (p.techniques || []).map(t => String(t.key || t.display_name || '').toUpperCase());
  return techs.length > 0 && !techs.some(t => PRINTABLE_TECHNIQUES.has(t));
}

// Full Printful catalog list (memoized 24h). Throws loud on a bad store/token.
async function getCatalogList() {
  return memo('catalog', 24 * 60 * 60 * 1000, async () => {
    const r = await printful.get('/products');
    if (r.status !== 200 || !Array.isArray(r.body?.result)) {
      throw new Error(`Printful /products failed (status ${r.status}): ${JSON.stringify(r.body?.error || r.body?.result || r.body).slice(0, 200)}`);
    }
    return r.body.result;
  });
}

// Run fn over items with bounded concurrency (Printful rate-limits; the client also backs off on 429).
async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  }));
}

// Min blank (Printful) price per catalog product, persisted to GCS so it survives cold starts.
const PRICES_GCS_KEY = 'catalog/prices.json';
let pricesCache = null;
async function computeCatalogPrices() {
  const list = (await getCatalogList()).filter(p => !isEmbroideryOnlyProduct(p));
  const prices = {};
  await mapLimit(list, 6, async (p) => {
    try {
      const vmap = await memo(`catalog-prices:${p.id}`, 6 * 60 * 60 * 1000, async () => {
        const r = await printful.get(`/products/${p.id}`);
        const out = {};
        for (const v of (r.body?.result?.variants || [])) { const n = parseFloat(v.price); if (n > 0) out[v.id] = n; }
        return out;
      });
      const vals = Object.values(vmap);
      if (vals.length) prices[p.id] = Math.min(...vals);
    } catch { /* skip products that error */ }
  });
  return prices;
}

app.get('/api/catalog/prices', async (req, res) => {
  try {
    if (req.query.refresh) { pricesCache = null; }
    if (!pricesCache) {
      try { const [buf] = await uploadBucket.file(PRICES_GCS_KEY).download(); pricesCache = JSON.parse(buf.toString()); } catch { /* not cached yet */ }
    }
    if (!pricesCache || req.query.refresh) {
      pricesCache = await computeCatalogPrices();
      try { await uploadBucket.file(PRICES_GCS_KEY).save(JSON.stringify(pricesCache), { contentType: 'application/json' }); } catch (e) { console.error('prices save failed', e); }
    }
    res.json({ count: Object.keys(pricesCache).length, prices: pricesCache });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/catalog', async (req, res) => {
  try {
    const list = await getCatalogList();
    const q = (req.query.q || '').toLowerCase();
    const cat = req.query.category;
    // Drop embroidery/knitwear-only products — they can't be made from a raster design and break runs.
    let out = list.filter(p => !isEmbroideryOnlyProduct(p));
    if (q) out = out.filter(p => (p.title || '').toLowerCase().includes(q) || (p.brand || '').toLowerCase().includes(q));
    if (cat) out = out.filter(p => String(p.main_category_id) === String(cat));
    res.json({ count: out.length, items: out });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/catalog/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const detail = await memo(`product:${id}`, 24 * 60 * 60 * 1000, async () => {
      const [info, printfiles, templates] = await Promise.all([
        printful.get(`/products/${id}`),
        printful.get(`/mockup-generator/printfiles/${id}`),
        printful.get(`/mockup-generator/templates/${id}`),
      ]);
      // Real placement names are the keys of available_placements; the printfiles[]
      // array carries dimensions but no `placement` field (the old map produced blanks
      // and made classifyPlacements always return 'single').
      const pf = printfiles.body?.result || {};
      const dims = dimsFromPrintfiles(pf);
      const placementNames = Object.keys(pf.available_placements || {});
      const placements = placementNames.map(name => ({
        placement: name,
        width: dims[name]?.width,
        height: dims[name]?.height,
      }));
      const wrap = classifyPlacements(placementNames);
      return {
        info: info.body?.result || null,
        placements,
        templates: templates.body?.result || null,
        wrap,
      };
    });
    res.json(detail);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

async function hostOnGcs(buf, filename, mime = 'image/png') {
  // Permanent public hosting on GCS. Raw bytes — PNG alpha preserved.
  const safe = String(filename || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-80);
  const key = `uploads/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
  await uploadBucket.file(key).save(buf, {
    contentType: mime,
    resumable: false,
    metadata: { cacheControl: 'public, max-age=31536000, immutable' },
  });
  return `https://storage.googleapis.com/${UPLOAD_BUCKET}/${key}`;
}
// Back-compat aliases used by uploadBufferToPrintful / job runner
const hostOnLitterbox = hostOnGcs;
const hostOnCatbox = hostOnGcs;

async function pollFileReady(fileId, maxSec = 60) {
  const start = Date.now();
  while (Date.now() - start < maxSec * 1000) {
    await new Promise(r => setTimeout(r, 2500));
    const r = await printful.get(`/files/${fileId}`);
    if (r.body?.result?.status === 'ok') return r.body.result;
    if (r.body?.result?.status === 'failed') return null;
  }
  return null;
}

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  try {
    // 1. host on GCS (permanent, original bytes — preserves PNG alpha)
    const originalUrl = await hostOnGcs(req.file.buffer, req.file.originalname, req.file.mimetype);
    // 2. tell Printful to ingest it (so we have a Printful file_id for sync_variants)
    const r = await printful.post('/files', {
      type: 'default',
      url: originalUrl,
      filename: req.file.originalname,
      visible: true,
    });
    if (r.status !== 200) return res.status(500).json({ error: r.body });
    const ready = await pollFileReady(r.body.result.id);
    // url = the ORIGINAL hosted on catbox (use this for sharp compositing — has alpha).
    // preview_url = Printful's CDN preview (use for thumbnails — flat render).
    res.json({
      id: r.body.result.id,
      url: originalUrl,
      preview_url: ready?.preview_url,
      raw: ready || r.body.result,
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Curated JBD drop art — hi-res originals mirrored from Drive into the GCS bucket under drops/<slug>/.
// Each strain has a Pattern + a Solid, and both pair with that strain's launch-collection logo.
const DROP_SLUG = 'ny-2026-drop-1';
const DROP_LABEL = 'NY 2026 Drop 1';
const DROP_STRAINS = ['Indica', 'Sativa', 'Hybrid'];

const DROP_PATTERNS = DROP_STRAINS.flatMap(strain => {
  const s = strain.toLowerCase();
  const logoFile = `${s}_logo.png`;
  return [
    { drop: DROP_SLUG, dropLabel: DROP_LABEL, strain, kind: 'pattern', label: `${strain} Pattern`, file: `${s}_pattern.jpg`, mime: 'image/jpeg', logoFile },
    { drop: DROP_SLUG, dropLabel: DROP_LABEL, strain, kind: 'solid',   label: `${strain} Solid`,   file: `${s}_solid.jpg`,   mime: 'image/jpeg', logoFile },
  ];
});

// Bump when re-uploading drop art — objects use immutable cache-control, so a version
// query param is required to bust Google's edge cache after an overwrite.
const DROP_ART_VERSION = '2';

app.get('/api/drop-patterns', (req, res) => {
  const base = `https://storage.googleapis.com/${UPLOAD_BUCKET}/drops`;
  const v = `?v=${DROP_ART_VERSION}`;
  const items = DROP_PATTERNS.map(p => ({
    drop: p.drop, dropLabel: p.dropLabel, strain: p.strain, kind: p.kind, label: p.label, file: p.file, mime: p.mime,
    url: `${base}/${p.drop}/${p.file}${v}`,
    logo: { label: `${p.strain} Logo`, file: p.logoFile, mime: 'image/png', url: `${base}/${p.drop}/${p.logoFile}${v}` },
  }));
  res.json({ items });
});

// Pickable logo library (in addition to the per-strain auto-pairing and manual upload).
const LOGO_LIBRARY = [
  { label: 'Graffiti Icon (JB)', file: 'logos/graffiti-icon.png' },
  { label: 'Indica Logo', file: 'drops/ny-2026-drop-1/indica_logo.png' },
  { label: 'Sativa Logo', file: 'drops/ny-2026-drop-1/sativa_logo.png' },
  { label: 'Hybrid Logo', file: 'drops/ny-2026-drop-1/hybrid_logo.png' },
];
app.get('/api/logos', (req, res) => {
  const base = `https://storage.googleapis.com/${UPLOAD_BUCKET}`;
  res.json({ items: LOGO_LIBRARY.map(l => ({ label: l.label, file: l.file, mime: 'image/png', url: `${base}/${l.file}?v=${DROP_ART_VERSION}` })) });
});

app.post('/api/ingest-url', async (req, res) => {
  const { url, filename } = req.body || {};
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'url required' });
  try {
    const r = await printful.post('/files', {
      type: 'default',
      url,
      filename: filename || url.split('/').pop(),
      visible: true,
    });
    if (r.status !== 200) return res.status(500).json({ error: r.body });
    const ready = await pollFileReady(r.body.result.id);
    res.json({
      id: r.body.result.id,
      url,
      preview_url: ready?.preview_url,
      raw: ready || r.body.result,
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/jobs', (req, res) => {
  const spec = req.body;
  if (!Array.isArray(spec?.products) || !Array.isArray(spec?.patterns) || !spec.patterns.length) {
    return res.status(400).json({ error: 'products[] and patterns[] required' });
  }
  // Each design needs a pattern OR a logo (or both). Logo may be per-design or a shared top-level one.
  for (const p of spec.patterns) {
    p.logo = p.logo || spec.logo || null;
    const hasPattern = p.fileId && p.url;
    const hasLogo = p.logo?.fileId && p.logo?.url;
    if (!hasPattern && !hasLogo) {
      return res.status(400).json({ error: `each design needs a pattern or a logo (missing on "${p.label || 'unnamed'}")` });
    }
  }
  const job = createJob(spec);
  res.json({ id: job.id });
  runJob(job).catch(err => emit(job, { type: 'error', error: String(err) }));
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json({ id: job.id, status: job.status, items: job.items, log: job.log });
});

app.get('/api/jobs/:id/stream', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).end();
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  for (const ev of job.log) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  if (job.status === 'done' || job.status === 'error') return res.end();
  const unsub = subscribe(job, ev => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
    if (ev.type === 'done' || ev.type === 'error') res.end();
  });
  req.on('close', unsub);
});

async function fetchPatternBuf(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch pattern ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function uploadBufferToPrintful(buf, filename) {
  // Printful /files rejects data URLs — host on litterbox first to get a real URL Printful can fetch
  const mime = /\.jpe?g$/i.test(filename) ? 'image/jpeg' : 'image/png';
  const publicUrl = await hostOnLitterbox(buf, filename, mime);
  const r = await printful.post('/files', { type: 'default', url: publicUrl, filename, visible: true });
  if (r.status !== 200) throw new Error('upload failed: ' + JSON.stringify(r.body).slice(0, 300));
  return { id: r.body.result.id, url: r.body.result.preview_url || publicUrl };
}

async function getCatalogDetail(catalogId) {
  return memo(`catalog-detail:${catalogId}`, 24 * 60 * 60 * 1000, async () => {
    const [info, pfRes] = await Promise.all([
      printful.get(`/products/${catalogId}`),
      printful.get(`/mockup-generator/printfiles/${catalogId}`),
    ]);
    if (info.status !== 200 || pfRes.status !== 200) {
      throw new Error(`Printful detail for catalog #${catalogId} failed (info ${info.status}, printfiles ${pfRes.status}): ${JSON.stringify(info.body?.error || pfRes.body?.error || info.body?.result).slice(0, 200)}`);
    }
    const pf = pfRes.body?.result || {};
    const available = Object.keys(pf.available_placements || {});
    // Only when the mockup data exposes NO printable placement (e.g. an embroidery-only hat that
    // also has a hidden front_dtf_hat) do we pull print placements from product.files. If front/back
    // already exist, adding the DTF-variant file types (front_dtf_tote…) duplicates the same area
    // with a different technique and Printful rejects the whole product.
    let placementNames = available;
    if (!available.some(p => placementRole(p) !== 'skip')) {
      const fileTypes = (info.body?.result?.product?.files || []).map(f => f.type).filter(Boolean);
      const printFileTypes = fileTypes.filter(t => !/^embroidery_/.test(t) && !['preview', 'mockup', 'default'].includes(t));
      placementNames = [...new Set([...available, ...printFileTypes])];
    }
    return {
      info: info.body?.result || null,
      placementNames,
      dims: dimsFromPrintfiles(pf),
      wrap: classifyPlacements(placementNames),
    };
  });
}

const SKIP_PLACEMENT = /^(label_|inside_label|branding)/i;

// "Fashion-designer" placement routing — decide where the PATTERN goes vs a clean LOGO.
//   logo    → small branding spots (sleeve, chest, pocket): drop the clean logo here
//   skip    → labels / inside / embroidery: we don't fill these from raster artwork
//   pattern → main body & canvas panels (front, back, default, all-over): the pattern is the statement
const LOGO_SPOT = /(sleeve|chest|breast|pocket|cuff|nape|collar|hip|hat|cap|beanie|visor)/i;
function placementRole(p) {
  if (SKIP_PLACEMENT.test(p) || /^(embroidery_|inside|neck)/i.test(p)) return 'skip';
  if (LOGO_SPOT.test(p)) return 'logo';
  return 'pattern';
}

// Aspect-preserving placement geometry (Printful `position`). Neither distorts the image.
//   coverBox  → scale UP to fill the whole print area, crop the overflow (all-over look)
//   containBox→ scale to fit INSIDE the area (optionally to a fraction), centered (clean accent)
function coverBox(aw, ah, dw, dh) {
  if (!aw || !ah || !dw || !dh) return null;
  const s = Math.max(aw / dw, ah / dh);
  const w = Math.round(dw * s), h = Math.round(dh * s);
  return { area_width: aw, area_height: ah, width: w, height: h, top: Math.round((ah - h) / 2), left: Math.round((aw - w) / 2) };
}
function containBox(aw, ah, dw, dh, fraction = 1) {
  if (!aw || !ah || !dw || !dh) return { area_width: aw, area_height: ah, width: aw, height: ah, top: 0, left: 0 };
  const s = Math.min(aw / dw, ah / dh) * fraction;
  const w = Math.round(dw * s), h = Math.round(dh * s);
  return { area_width: aw, area_height: ah, width: w, height: h, top: Math.round((ah - h) / 2), left: Math.round((aw - w) / 2) };
}

// Pixel dims of a hosted image, memoized by file id (patterns/logos are reused across products).
async function imgDimsCached(url, key) {
  return memo(`imgdims:${key}`, 6 * 60 * 60 * 1000, async () => {
    try { return await imageDims(await fetchPatternBuf(url)); } catch { return null; }
  });
}

// A position that maps an already-panel-sized image 1:1 onto the print area (no scaling).
function exactBox(w, h) { return { area_width: w, area_height: h, width: w, height: h, top: 0, left: 0 }; }

// Snap an {r,g,b} to the nearest hex in an embroidery thread palette (squared RGB distance).
function hexToRgb(h) { return { r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) }; }
function snapToPalette(c, hexes) {
  let best = hexes[0], bd = Infinity;
  for (const h of hexes) { const p = hexToRgb(h); const d = (p.r - c.r) ** 2 + (p.g - c.g) ** 2 + (p.b - c.b) ** 2; if (d < bd) { bd = d; best = h; } }
  return best;
}

// Build a big all-over panel by TILING the pattern at the panel's exact size (full motifs,
// repeated — no zoom/crop), optionally compositing the logo at a fractional anchor. Returns {id,url}.
async function tiledPanelFile(pat, w, h, { logo, logoOpts } = {}) {
  const lkey = logo ? `${logo.fileId}:${logoOpts?.xFrac}x${logoOpts?.yFrac}:${logoOpts?.scale}` : 'plain';
  return memo(`tile:${pat.fileId}:${w}x${h}:${lkey}`, 60 * 60 * 1000, async () => {
    const patternBuf = await fetchPatternBuf(pat.url);
    const logoBuf = logo ? await fetchPatternBuf(logo.url) : null;
    const buf = await tileToCanvas(patternBuf, w, h, {
      logoBuf, logoScale: logoOpts?.scale, xFrac: logoOpts?.xFrac, yFrac: logoOpts?.yFrac,
    });
    const safe = (pat.label || 'pattern').replace(/[^a-z0-9]+/gi, '_');
    return uploadBufferToPrintful(buf, `${safe}_tile_${w}x${h}${logo ? '_logo' : ''}.jpg`);
  });
}

// Composite the logo onto the pattern (logo aspect preserved) and host it; returns {id, url}.
async function mergeLogoOntoPattern(pat, logo, prodId, opts = {}) {
  const { gravity = 'center', scale = 0.3, xFrac, yFrac } = opts;
  const tag = xFrac != null ? `${xFrac}x${yFrac}` : gravity;
  return memo(`merge:${pat.fileId}:${logo.fileId}:${prodId}:${tag}:${scale}`, 60 * 60 * 1000, async () => {
    const patternBuf = await fetchPatternBuf(pat.url);
    const logoBuf = await fetchPatternBuf(logo.url);
    const buf = await compositeLogo(patternBuf, logoBuf, { gravity, scale, xFrac, yFrac });
    const safeName = (pat.label || 'pattern').replace(/[^a-z0-9]+/gi, '_');
    return uploadBufferToPrintful(buf, `${safeName}_${tag}_logo.png`);
  });
}

// Per-catalog logo placement recipe (where + how to apply user's logo)
const LOGO_RECIPES = {
  // canvas high-top: tongue = solid color of pattern + logo centered
  513: { kind: 'canvas-shoe-tongue' },
  // women's slip-on: composite logo on pattern at top-center
  575: { kind: 'composite', gravity: 'north', scale: 0.35 },
  // bike shorts: composite on belt_front, smaller
  507: { kind: 'composite', gravity: 'center', scale: 0.4, onlyPlacements: ['belt_front', 'belt_back'] },
  // tote
  84:  { kind: 'composite', gravity: 'center', scale: 0.35 },
  // beach towel: corner
  259: { kind: 'composite', gravity: 'southeast', scale: 0.18 },
  // tough phone case: small bottom-center
  601: { kind: 'composite', gravity: 'south', scale: 0.22 },
  // AOP tee
  257: { kind: 'composite', gravity: 'center', scale: 0.25 },
  // backpack
  242: { kind: 'composite', gravity: 'center', scale: 0.28 },
};

function isEmbroideryOnly(placementNames) {
  if (!placementNames.length) return false;
  return placementNames.every(p => /^embroidery_/.test(p) || SKIP_PLACEMENT.test(p));
}

async function buildFilesForVariant(prod, pat, detail, logo) {
  const recipe = LOGO_RECIPES[prod.id] || (logo ? { kind: 'composite', gravity: 'center', scale: 0.25 } : null);
  const hasPattern = !!(pat && pat.url && pat.fileId);

  // ---------- LOGO-ONLY (no pattern): clean logo on the display side, no background fill ----------
  if (!hasPattern && logo && !isEmbroideryOnly(detail.placementNames)) {
    const usable = detail.placementNames.filter(p => placementRole(p) !== 'skip');
    const spot = usable.find(p => /front/i.test(p)) || usable.find(p => placementRole(p) === 'logo') || usable[0] || detail.placementNames[0] || 'default';
    const ld = await imgDimsCached(logo.url, logo.fileId);
    const a = detail.dims[spot];
    const f = { type: spot, id: logo.fileId, srcUrl: logo.url, fit: 'contain', fraction: 0.6 };
    if (a?.width && a?.height) f.position = containBox(a.width, a.height, ld?.width, ld?.height, 0.6);
    return [f];
  }

  // ---------- EMBROIDERY-ONLY (hats, embroidered patches) ----------
  if (isEmbroideryOnly(detail.placementNames)) {
    if (!logo) throw new Error(`Catalog #${prod.id} is embroidery-only — please upload a logo.`);
    const placements = detail.placementNames.filter(p => !SKIP_PLACEMENT.test(p));
    // full_color = unlimited-color embroidery → an exact match of the logo's colors. We also pass
    // the logo's dominant colors snapped to this product's thread palette (the option is required;
    // its id is placement-suffixed, e.g. thread_colors_front_large).
    const palette = Object.keys((detail.info?.product?.options?.find(o => o.id === 'thread_colors') || {}).values || {});
    let threads = ['#000000'];
    if (palette.length) {
      try {
        const cols = await dominantColors(await fetchPatternBuf(logo.url), 4);
        const snapped = [...new Set(cols.map(c => snapToPalette(c, palette)))];
        if (snapped.length) threads = snapped.slice(0, 6);
      } catch { /* fall back to black */ }
    }
    return placements.map(p => {
      const base = p.replace(/^embroidery_/, '');
      return {
        type: p,
        id: logo.fileId,
        srcUrl: logo.url, fit: 'contain', fraction: 0.8, // hero mockup: logo embroidered on the blank
        options: [
          { id: 'full_color', value: true },
          { id: `thread_colors_${base}`, value: threads },
        ],
      };
    });
  }

  // ---------- CANVAS HIGH-TOP (shoe_quarters_* — heel mirror + tongue solid+logo) ----------
  if (detail.wrap.kind === 'canvas-shoe' && detail.placementNames.some(p => /shoe_quarters/.test(p))) {
    const cacheKey = `shoe-build:${prod.id}:${pat.fileId}:${logo?.fileId || 'nologo'}`;
    return memo(cacheKey, 60 * 60 * 1000, async () => {
      const patternBuf = await fetchPatternBuf(pat.url);
      const logoBuf = logo ? await fetchPatternBuf(logo.url) : null;
      const built = await buildShoeFiles(patternBuf, {
        quarter: detail.dims.shoe_quarters_left || { width: 2250, height: 2250 },
        tongue: null, // build custom below
      });
      // Tongue = solid primary-color + logo centered, OR pattern fitted if no logo
      let tongueBuf;
      const tDim = detail.dims.shoe_tongue_left || { width: 2250, height: 2250 };
      if (logoBuf) {
        const color = await getPrimaryColor(patternBuf);
        tongueBuf = await solidWithLogo({ width: tDim.width, height: tDim.height, color, logoBuf, logoScale: 0.5 });
      } else {
        tongueBuf = await fitToCanvas(patternBuf, { width: tDim.width, height: tDim.height });
      }
      const safeName = (pat.label || 'pattern').replace(/[^a-z0-9]+/gi, '_');
      const [left, right, tongue] = await Promise.all([
        uploadBufferToPrintful(built.quarters_left,  `${safeName}_quarters_left.png`),
        uploadBufferToPrintful(built.quarters_right, `${safeName}_quarters_right.png`),
        uploadBufferToPrintful(tongueBuf,            `${safeName}_tongue.png`),
      ]);
      return [
        { type: 'shoe_quarters_left',  id: left.id },
        { type: 'shoe_quarters_right', id: right.id },
        { type: 'shoe_tongue_left',  id: tongue.id },
        { type: 'shoe_tongue_right', id: tongue.id },
      ];
    });
  }

  // ---------- GENERAL MULTI-PLACEMENT ----------
  const usableAll = detail.placementNames.filter(p => placementRole(p) !== 'skip');
  if (usableAll.length === 0) {
    return [{ type: detail.placementNames[0] || 'default', id: pat.fileId, srcUrl: pat.url, fit: 'cover' }];
  }
  // Size-variant panels (e.g. front vs front_large) cover the same physical area — keep the
  // LARGER one for fuller coverage and never fill both (filling both conflicts on Printful).
  const largeBases = new Set(usableAll.filter(p => /_large$/.test(p)).map(p => p.replace(/_large$/, '')));
  const usable = usableAll.filter(p => !largeBases.has(p));

  const pdim = await imgDimsCached(pat.url, pat.fileId);
  const ldim = logo ? await imgDimsCached(logo.url, logo.fileId) : null;
  const areaOf = p => { const d = detail.dims[p]; return d ? (d.width || 0) * (d.height || 0) : 0; };

  const coverScaleOf = p => {
    const a = detail.dims[p] || {};
    if (!a.width || !pdim?.width) return 1;
    return Math.max(a.width / pdim.width, a.height / pdim.height);
  };
  // A pattern panel. If covering would zoom one motif up >1.2× (big all-over panels), TILE the
  // pattern at natural scale so full motifs repeat (no zoom/crop); otherwise cover (no zoom-up).
  const patFile = async p => {
    const a = detail.dims[p] || {};
    if (coverScaleOf(p) > 1.2 && a.width && a.height) {
      const tp = await tiledPanelFile(pat, a.width, a.height);
      return { type: p, id: tp.id, position: exactBox(a.width, a.height), srcUrl: tp.url, fit: 'exact' };
    }
    return { type: p, id: pat.fileId, position: coverBox(a.width, a.height, pdim?.width, pdim?.height) || undefined, srcUrl: pat.url, fit: 'cover' };
  };

  const mainSpots = usable.filter(p => placementRole(p) === 'pattern');
  const mainArea = mainSpots.reduce((m, p) => Math.max(m, areaOf(p)), 0);
  // A branding spot carries the clean logo ONLY if it's a small accent area. Large panels
  // (e.g. all-over sleeves) get the pattern instead, so NO panel is ever left blank.
  const logoSpots = usable.filter(p => placementRole(p) === 'logo' && (mainArea ? areaOf(p) <= 0.5 * mainArea : true));

  // (A) Garment with small branding spots (DTG tees/hoodies): pattern on body, clean logo on sleeves/chest.
  if (logo && logoSpots.length && mainSpots.length) {
    return Promise.all(usable.map(async p => {
      if (!logoSpots.includes(p)) return patFile(p);
      const a = detail.dims[p] || {};
      return { type: p, id: logo.fileId, position: containBox(a.width, a.height, ldim?.width, ldim?.height, 0.8), srcUrl: logo.url, fit: 'contain', fraction: 0.8 };
    }));
  }

  // (A2) Single front print spot, no dedicated body panel (caps/hats — front_dtf_hat etc.):
  //   - pattern selected → fill the front with the PATTERN (tiled if covering would zoom a motif up,
  //     else cover), compositing the logo on top so the strain art actually prints. Previously this
  //     always dropped a bare logo and silently ignored the pattern (the "all hats are logo-only" bug).
  //   - logo only        → clean logo on the front, no background fill.
  if (logoSpots.length && !mainSpots.length) {
    if (hasPattern) {
      const logoOpts = { xFrac: 0.5, yFrac: 0.5, scale: 0.4 };
      return Promise.all(logoSpots.map(async p => {
        const a = detail.dims[p] || {};
        if (coverScaleOf(p) > 1.2 && a.width && a.height) {
          const tp = await tiledPanelFile(pat, a.width, a.height, logo ? { logo, logoOpts } : {});
          return { type: p, id: tp.id, position: exactBox(a.width, a.height), srcUrl: tp.url, fit: 'exact' };
        }
        if (logo) {
          const merged = await mergeLogoOntoPattern(pat, logo, prod.id, logoOpts);
          return { type: p, id: merged.id, position: coverBox(a.width, a.height, pdim?.width, pdim?.height) || undefined, srcUrl: merged.url, fit: 'cover' };
        }
        return patFile(p);
      }));
    }
    if (logo) {
      return logoSpots.map(p => {
        const a = detail.dims[p];
        const f = { type: p, id: logo.fileId, srcUrl: logo.url, fit: 'contain', fraction: 0.9 };
        if (a?.width && a?.height) f.position = containBox(a.width, a.height, ldim?.width, ldim?.height, 0.9);
        return f;
      });
    }
  }

  // (B) All-over / single-surface items with NO small branding spot (swimwear, totes, cases…):
  //     tile the pattern across every panel; composite the logo onto ONE panel so it's visible
  //     on the finished piece — e.g. centered on the back/seat of a swimsuit bottom.
  if (logo) {
    // Where the logo lands (fractional anchor of the panel). Verified on the string bikini: the
    // RIGHT ~78% of the wide `bottom` print is the seat; dead-center lands in the hidden gusset.
    let logoPanel = recipe?.logoPanel, logoOpts;
    if (logoPanel) {
      logoOpts = { gravity: recipe.gravity, scale: recipe.scale ?? 0.4, xFrac: recipe.xFrac, yFrac: recipe.yFrac };
    } else if ((logoPanel = usable.find(p => p === 'bottom'))) {
      logoOpts = { xFrac: 0.78, yFrac: 0.5, scale: 0.2 };            // swimsuit seat (right ~78% of the wide bottom print)
    } else {
      // Display side: prefer FRONT, never default the logo onto a hidden back panel. Sized prominent.
      logoPanel = usable.find(p => /front/i.test(p)) || usable.find(p => !/back/i.test(p)) || usable[0];
      logoOpts = { xFrac: 0.5, yFrac: 0.5, scale: 0.4 };
    }

    if (logoPanel) {
      return Promise.all(usable.map(async p => {
        if (p !== logoPanel) return patFile(p);
        const a = detail.dims[p] || {};
        // Big panel → tile + composite logo at exact coords; small panel → merge over the pattern.
        if (coverScaleOf(p) > 1.2 && a.width && a.height && logoOpts.xFrac != null) {
          const tp = await tiledPanelFile(pat, a.width, a.height, { logo, logoOpts });
          return { type: p, id: tp.id, position: exactBox(a.width, a.height), srcUrl: tp.url, fit: 'exact' };
        }
        const merged = await mergeLogoOntoPattern(pat, logo, prod.id, logoOpts);
        return { type: p, id: merged.id, position: coverBox(a.width, a.height, pdim?.width, pdim?.height) || undefined, srcUrl: merged.url, fit: 'cover' };
      }));
    }
    // Recipe restricted to specific panels (e.g. bike-shorts belt) — merged there, pattern elsewhere.
    if (recipe?.kind === 'composite' && recipe.onlyPlacements?.length) {
      const merged = await mergeLogoOntoPattern(pat, logo, prod.id, { gravity: recipe.gravity, scale: recipe.scale });
      return Promise.all(usable.map(async p => {
        if (!recipe.onlyPlacements.includes(p)) return patFile(p);
        const a = detail.dims[p] || {};
        return { type: p, id: merged.id, position: coverBox(a.width, a.height, pdim?.width, pdim?.height) || undefined, srcUrl: merged.url, fit: 'cover' };
      }));
    }
  }

  // (C) No logo: pattern on every panel (tiled where it would otherwise zoom up)
  return Promise.all(usable.map(patFile));
}

async function pollMockupTask(taskKey, maxSec = 180) {
  const start = Date.now();
  while (Date.now() - start < maxSec * 1000) {
    const r = await printful.get(`/mockup-generator/task?task_key=${taskKey}`);
    const s = r.body?.result?.status;
    if (s === 'completed' || s === 'failed') return r.body.result;
    await new Promise(r => setTimeout(r, 3000));
  }
  return { status: 'timeout' };
}

async function pollPrintfulFile(fileId, maxSec = 60) {
  const start = Date.now();
  while (Date.now() - start < maxSec * 1000) {
    await new Promise(r => setTimeout(r, 2500));
    const r = await printful.get(`/files/${fileId}`);
    if (r.body?.result?.status === 'ok') return r.body.result;
    if (r.body?.result?.status === 'failed') return null;
  }
  return null;
}

async function generateAndSetThumbnail(catalogId, variantId, files, patUrl, detail, syncId, logoUrl) {
  // Render EXACTLY what will print: each file carries its source image (srcUrl) and fit
  // ('cover' for patterns/merged panels, 'contain' for clean logo accents). Aspect is always
  // preserved — cover scales up & crops, contain fits inside; we never stretch to the area.
  const design = await imageDims(await fetchPatternBuf(patUrl)).catch(() => null);
  const logoSize = logoUrl ? await imgDimsCached(logoUrl, 'mockup-logo:' + logoUrl).catch(() => null) : null;

  const filesPayload = files.map(f => {
    const a = detail.dims[f.type] || { width: 1800, height: 1800 };
    let position;
    if (f.fit === 'exact') {
      // already panel-sized (tiled all-over panel) → map 1:1
      position = { area_width: a.width, area_height: a.height, width: a.width, height: a.height, top: 0, left: 0 };
    } else if (f.fit === 'contain') {
      position = containBox(a.width, a.height, logoSize?.width, logoSize?.height, f.fraction || 0.8);
    } else {
      position = coverBox(a.width, a.height, design?.width, design?.height) || { area_width: a.width, area_height: a.height, width: a.width, height: a.height, top: 0, left: 0 };
    }
    return { placement: f.type, image_url: f.srcUrl || patUrl, position };
  });
  const task = await printful.post(`/mockup-generator/create-task/${catalogId}`, {
    variant_ids: [variantId],
    format: 'jpg',
    files: filesPayload,
  });
  if (task.status !== 200 || !task.body?.result?.task_key) throw new Error(`mockup create-task ${task.status}: ${JSON.stringify(task.body?.result || task.body).slice(0, 200)}`);
  const result = await pollMockupTask(task.body.result.task_key);
  if (result.status !== 'completed' || !result.mockups?.length) throw new Error(`mockup task ${result.status}: ${JSON.stringify(result).slice(0, 200)}`);

  // Pick lifestyle if available, else first
  const flat = result.mockups.flatMap(m => [{ url: m.mockup_url }, ...(m.extra || []).map(e => ({ url: e.url, title: e.title }))]);
  const chosen = flat.find(m => /lifestyle/i.test(m.url)) || flat[0];

  // Permanentize on OUR GCS bucket (instant). Re-ingesting into Printful's /files can take minutes
  // to reach status:ok, blowing past any poll and leaving the raw-pattern fallback (the bikini/case bug).
  const buf = await fetchPatternBuf(chosen.url);
  const permUrl = await hostOnGcs(buf, `mockup_${syncId}.jpg`, 'image/jpeg');

  // Update the sync_product thumbnail
  await printful.put(`/store/products/${syncId}`, { sync_product: { thumbnail: permUrl } });
  return permUrl;
}

// Host an edited-art buffer on GCS (full-res, for our sharp re-fetch) and ingest it into Printful
// (for sync_variants). Returns { id, url } where url is the raw GCS object.
async function hostEditedArt(buf, label) {
  const safe = (label || 'design').replace(/[^a-z0-9]+/gi, '_');
  const publicUrl = await hostOnGcs(buf, `${safe}_edited.jpg`, 'image/jpeg');
  const r = await printful.post('/files', { type: 'default', url: publicUrl, filename: `${safe}_edited.jpg`, visible: true });
  if (r.status !== 200) throw new Error('edited-art upload failed: ' + JSON.stringify(r.body).slice(0, 200));
  return { id: r.body.result.id, url: publicUrl };
}

// Apply the user's per-design instructions (run ONCE per design, before products are built):
//   notes → AI-regenerate the art with google/nano-banana
//   text  → burn the text onto the art with sharp
// Edits the PRIMARY art (the pattern if present, else the logo) and re-points the design at the
// new Printful file. Throws loud on failure so the caller can fail the design instead of silently
// creating products with un-edited art.
async function applyDesignEdits(pat, job) {
  const notes = (pat.notes || '').trim();
  const text = (pat.text || '').trim();
  if (!notes && !text) return;
  const target = (pat.url && pat.fileId) ? pat : pat.logo; // pattern art, or logo for logo-only designs
  if (!target?.url) return;

  let buf = null;
  if (notes) {
    emit(job, { type: 'edit', label: pat.label, step: 'ai-regenerate' });
    buf = await regenerateArt(target.url, notes, { token: REPLICATE_TOKEN });
  }
  if (text) {
    emit(job, { type: 'edit', label: pat.label, step: 'add-text' });
    if (!buf) buf = await fetchPatternBuf(target.url);
    buf = await compositeText(buf, text, { position: pat.textPos || 'top', color: pat.textColor || '#ffffff' });
  }
  const uploaded = await hostEditedArt(buf, pat.label);
  target.fileId = uploaded.id;
  target.url = uploaded.url;
  emit(job, { type: 'edit-ok', label: pat.label, url: uploaded.url });
}

async function runJob(job) {
  job.status = 'running';
  emit(job, { type: 'start', total: job.spec.products.length * job.spec.patterns.length });
  const { products, patterns, retailPrices = {} } = job.spec;

  for (const pat of patterns) {
    // Apply per-design instructions (AI notes + added text) ONCE, before any product is built.
    // If the edit fails, fail the whole design loudly rather than create products with un-edited art.
    let editError = null;
    try { await applyDesignEdits(pat, job); }
    catch (e) { editError = String(e); emit(job, { type: 'edit-fail', label: pat.label, error: editError }); }

    const patLogo = pat.logo; // each design carries its own paired logo (may be the only art)
    const primaryUrl = pat.url || patLogo?.url; // logo-only designs have no pattern
    for (const prod of products) {
      const label = `${prod.title || prod.id} / ${pat.label}`;
      emit(job, { type: 'item-start', label });
      if (editError) {
        job.items.push({ label, ok: false, error: `design edit failed: ${editError}` });
        emit(job, { type: 'item-fail', label, error: `design edit failed: ${editError}` });
        continue;
      }
      try {
        const detail = await getCatalogDetail(prod.id);
        emit(job, { type: 'item-info', label, wrap: detail.wrap.kind, placements: detail.placementNames });
        const variants = detail.info?.variants || [];
        const files = await buildFilesForVariant(prod, pat, detail, patLogo);
        // Printful only wants type/id/position/options — strip our internal mockup hints.
        const printfulFiles = files.map(f => {
          const o = { type: f.type, id: f.id };
          if (f.position) o.position = f.position;
          if (f.options) o.options = f.options;
          return o;
        });
        // Printful caps a sync product at 100 variants (big tees exceed this) — cap to avoid a hard fail.
        const capped = variants.slice(0, 100);
        if (variants.length > 100) emit(job, { type: 'item-info', label, note: `capped ${variants.length}→100 variants (Printful limit)` });
        const sync_variants = capped.map(v => ({
          variant_id: v.id,
          retail_price: retailPrices[prod.id] || prod.retail || '29.00',
          files: printfulFiles,
        }));
        const name = `${prod.title || `Product ${prod.id}`} - ${pat.label}`;
        const r = await printful.post('/store/products', {
          // is_ignored = false → visible/live in the store (appears in Printful + on the quickshop)
          sync_product: { name, thumbnail: primaryUrl, is_ignored: false },
          sync_variants,
        });
        if (r.status !== 200) {
          job.items.push({ label, ok: false, error: r.body });
          emit(job, { type: 'item-fail', label, error: r.body });
          await new Promise(r => setTimeout(r, 7000));
          continue;
        }
        const syncId = r.body.result?.id;
        emit(job, { type: 'item-created', label, sync_id: syncId });

        // Auto-generate mockup + set as clean hero image
        let thumbUrl = primaryUrl;
        try {
          const v0 = variants[0]?.id;
          if (v0) {
            const perm = await generateAndSetThumbnail(prod.id, v0, files, primaryUrl, detail, syncId, patLogo?.url);
            if (perm) thumbUrl = perm;
          }
        } catch (e) {
          emit(job, { type: 'mockup-warn', label, error: String(e) });
        }

        job.items.push({ label, ok: true, sync_id: syncId, wrap: detail.wrap.kind, product_title: prod.title, thumbnail: thumbUrl, placements: files.map(f => f.type) });
        emit(job, { type: 'item-ok', label, sync_id: syncId, wrap: detail.wrap.kind, product_title: prod.title, thumbnail: thumbUrl });
      } catch (err) {
        job.items.push({ label, ok: false, error: String(err) });
        emit(job, { type: 'item-fail', label, error: String(err) });
      }
      await new Promise(r => setTimeout(r, 7000));
    }
  }

  job.status = 'done';
  emit(job, { type: 'done', items: job.items });
}

attachShopRoutes(app, printful);
attachTemplateRoutes(app, printful);

app.listen(PORT, () => console.log(`jb-printful-api listening on :${PORT}`));

export { app, buildShoeFiles, fitToCanvas };
