import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { Storage } from '@google-cloud/storage';
import { pf } from './printful.js';
import { memo } from './cache.js';
import { classifyPlacements, buildShoeFiles, fitToCanvas, dimsFromPrintfiles, getPrimaryColor, solidWithLogo, compositeLogo, imageDims } from './wrap.js';
import { createJob, getJob, emit, subscribe } from './jobs.js';
import { attachShopRoutes } from './shop.js';
import { attachTemplateRoutes } from './templates.js';

const PORT = parseInt(process.env.PORT || '8080');
const TOKEN = process.env.PRINTFUL_TOKEN;
const STORE_ID = process.env.STORE_ID;
const APP_PASSWORD = process.env.APP_PASSWORD;
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

app.get('/api/catalog', async (req, res) => {
  try {
    const list = await memo('catalog', 24 * 60 * 60 * 1000, async () => {
      const r = await printful.get('/products');
      // Fail loud: a bad STORE_ID/token returns 200-shaped errors or a string in `result`.
      // Never cache that as the catalog — it renders as imageless ghost cards.
      if (r.status !== 200 || !Array.isArray(r.body?.result)) {
        throw new Error(`Printful /products failed (status ${r.status}): ${JSON.stringify(r.body?.error || r.body?.result || r.body).slice(0, 200)}`);
      }
      return r.body.result;
    });
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
  // Backwards-compat: top-level spec.logo applies to all patterns if patterns don't have their own
  for (const p of spec.patterns) {
    const lg = p.logo || spec.logo;
    if (!lg?.fileId || !lg?.url) {
      return res.status(400).json({ error: `each pattern must have a paired logo (missing on "${p.label || 'unnamed'}")` });
    }
    p.logo = lg;
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
  const publicUrl = await hostOnLitterbox(buf, filename, 'image/png');
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
    const placementNames = Object.keys(pf.available_placements || {});
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
const LOGO_SPOT = /(sleeve|chest|breast|pocket|cuff|nape|collar|hip)/i;
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

  // ---------- EMBROIDERY-ONLY (hats, embroidered patches) ----------
  if (isEmbroideryOnly(detail.placementNames)) {
    if (!logo) throw new Error(`Catalog #${prod.id} is embroidery-only — please upload a logo.`);
    const placements = detail.placementNames.filter(p => !SKIP_PLACEMENT.test(p));
    return placements.map(p => ({
      type: p,
      id: logo.fileId,
      options: [
        { id: 'thread_colors', value: ['#000000'] },
        { id: 'embroidery_type', value: 'flat' },
      ],
    }));
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

  // Pattern COVERS its panel (fills edge-to-edge, scaled uniformly, overflow cropped — visible & clean).
  const patFile = p => {
    const a = detail.dims[p] || {};
    return { type: p, id: pat.fileId, position: coverBox(a.width, a.height, pdim?.width, pdim?.height) || undefined, srcUrl: pat.url, fit: 'cover' };
  };

  const mainSpots = usable.filter(p => placementRole(p) === 'pattern');
  const mainArea = mainSpots.reduce((m, p) => Math.max(m, areaOf(p)), 0);
  // A branding spot carries the clean logo ONLY if it's a small accent area. Large panels
  // (e.g. all-over sleeves) get the pattern instead, so NO panel is ever left blank.
  const logoSpots = usable.filter(p => placementRole(p) === 'logo' && (mainArea ? areaOf(p) <= 0.5 * mainArea : true));

  // (A) Garment with small branding spots (DTG tees/hoodies): pattern covers the body,
  //     a clean undistorted logo accents the sleeves/chest. Every panel covered.
  if (logo && logoSpots.length && mainSpots.length) {
    return usable.map(p => {
      if (!logoSpots.includes(p)) return patFile(p);
      const a = detail.dims[p] || {};
      return { type: p, id: logo.fileId, position: containBox(a.width, a.height, ldim?.width, ldim?.height, 0.8), srcUrl: logo.url, fit: 'contain', fraction: 0.8 };
    });
  }

  // (B) All-over / single-surface items with NO small branding spot (swimwear, totes, cases…):
  //     pattern covers every panel, and the logo is composited onto ONE chosen panel so it is
  //     actually visible on the finished piece — e.g. the back/seat of a swimsuit bottom.
  if (logo) {
    // Choose the panel + where on it the logo lands (verified on the string bikini: the RIGHT
    // ~80% of the wide `bottom` print maps to the seat; dead-center lands in the hidden gusset).
    let logoPanel = recipe?.logoPanel, logoOpts;
    if (logoPanel) {
      logoOpts = { gravity: recipe.gravity, scale: recipe.scale ?? 0.25, xFrac: recipe.xFrac, yFrac: recipe.yFrac };
    } else if ((logoPanel = usable.find(p => /back/i.test(p)))) {
      logoOpts = { gravity: 'center', scale: 0.25 };                 // true back panel → centered
    } else if ((logoPanel = usable.find(p => p === 'bottom'))) {
      logoOpts = { xFrac: 0.8, yFrac: 0.5, scale: 0.16 };            // swim seat
    } else if (recipe?.kind === 'composite' && !recipe.onlyPlacements?.length) {
      logoPanel = usable[0];
      logoOpts = { gravity: recipe.gravity || 'center', scale: recipe.scale || 0.3 };
    }

    if (logoPanel) {
      const merged = await mergeLogoOntoPattern(pat, logo, prod.id, logoOpts);
      return usable.map(p => {
        if (p !== logoPanel) return patFile(p);
        const a = detail.dims[p] || {};
        return { type: p, id: merged.id, position: coverBox(a.width, a.height, pdim?.width, pdim?.height) || undefined, srcUrl: merged.url, fit: 'cover' };
      });
    }
    // Recipe restricted to specific panels (e.g. bike-shorts belt) — merged there, pattern elsewhere.
    if (recipe?.kind === 'composite' && recipe.onlyPlacements?.length) {
      const merged = await mergeLogoOntoPattern(pat, logo, prod.id, { gravity: recipe.gravity, scale: recipe.scale });
      return usable.map(p => {
        const a = detail.dims[p] || {};
        const useMerged = recipe.onlyPlacements.includes(p);
        return { type: p, id: useMerged ? merged.id : pat.fileId, position: coverBox(a.width, a.height, pdim?.width, pdim?.height) || undefined, srcUrl: useMerged ? merged.url : pat.url, fit: 'cover' };
      });
    }
  }

  // (C) No logo: pattern covers every panel
  return usable.map(patFile);
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
    const isLogo = f.fit === 'contain';
    const dims = isLogo ? logoSize : design; // patterns AND merged panels are pattern-sized
    const position = isLogo
      ? containBox(a.width, a.height, dims?.width, dims?.height, f.fraction || 0.8)
      : (coverBox(a.width, a.height, dims?.width, dims?.height) || { area_width: a.width, area_height: a.height, width: a.width, height: a.height, top: 0, left: 0 });
    return { placement: f.type, image_url: f.srcUrl || patUrl, position };
  });
  const task = await printful.post(`/mockup-generator/create-task/${catalogId}`, {
    variant_ids: [variantId],
    format: 'jpg',
    files: filesPayload,
  });
  if (task.status !== 200 || !task.body?.result?.task_key) return null;
  const result = await pollMockupTask(task.body.result.task_key);
  if (result.status !== 'completed' || !result.mockups?.length) return null;

  // Pick lifestyle if available, else first
  const flat = result.mockups.flatMap(m => [{ url: m.mockup_url }, ...(m.extra || []).map(e => ({ url: e.url, title: e.title }))]);
  const chosen = flat.find(m => /lifestyle/i.test(m.url)) || flat[0];

  // Permanentize on Printful CDN
  const ingest = await printful.post('/files', { type: 'default', url: chosen.url, filename: `mockup_${syncId}.jpg`, visible: false });
  if (ingest.status !== 200) return null;
  const ready = await pollPrintfulFile(ingest.body.result.id);
  const permUrl = ready?.preview_url;
  if (!permUrl) return null;

  // Update the sync_product thumbnail
  await printful.put(`/store/products/${syncId}`, { sync_product: { thumbnail: permUrl } });
  return permUrl;
}

async function runJob(job) {
  job.status = 'running';
  emit(job, { type: 'start', total: job.spec.products.length * job.spec.patterns.length });
  const { products, patterns, retailPrices = {} } = job.spec;

  for (const pat of patterns) {
    const patLogo = pat.logo; // each pattern carries its own paired logo
    for (const prod of products) {
      const label = `${prod.title || prod.id} / ${pat.label}`;
      emit(job, { type: 'item-start', label });
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
        const sync_variants = variants.map(v => ({
          variant_id: v.id,
          retail_price: retailPrices[prod.id] || prod.retail || '29.00',
          files: printfulFiles,
        }));
        const name = `${prod.title || `Product ${prod.id}`} - ${pat.label}`;
        const r = await printful.post('/store/products', {
          // is_ignored = true → saved as a template-equivalent: in dashboard but not on storefront
          sync_product: { name, thumbnail: pat.url, is_ignored: true },
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
        let thumbUrl = pat.url;
        try {
          const v0 = variants[0]?.id;
          if (v0) {
            const perm = await generateAndSetThumbnail(prod.id, v0, files, pat.url, detail, syncId, patLogo?.url);
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
