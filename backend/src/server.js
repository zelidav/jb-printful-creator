import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { pf } from './printful.js';
import { memo } from './cache.js';
import { classifyPlacements, buildShoeFiles, fitToCanvas, dimsFromPrintfiles } from './wrap.js';
import { createJob, getJob, emit, subscribe } from './jobs.js';
import { attachShopRoutes } from './shop.js';

const PORT = parseInt(process.env.PORT || '8080');
const TOKEN = process.env.PRINTFUL_TOKEN;
const STORE_ID = process.env.STORE_ID;
const APP_PASSWORD = process.env.APP_PASSWORD;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

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

app.get('/api/catalog', async (req, res) => {
  try {
    const list = await memo('catalog', 24 * 60 * 60 * 1000, async () => {
      const r = await printful.get('/products');
      return r.body?.result || [];
    });
    const q = (req.query.q || '').toLowerCase();
    const cat = req.query.category;
    let out = list;
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
      const placements = printfiles.body?.result?.printfiles?.map(p => ({
        placement: p.placement,
        width: p.width,
        height: p.height,
      })) || [];
      const wrap = classifyPlacements(placements);
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

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  try {
    const b64 = req.file.buffer.toString('base64');
    const dataUrl = `data:${req.file.mimetype};base64,${b64}`;
    const r = await printful.post('/files', {
      type: 'default',
      url: dataUrl,
      filename: req.file.originalname,
      visible: true,
    });
    if (r.status !== 200) return res.status(500).json({ error: r.body });
    res.json({ id: r.body.result.id, url: r.body.result.preview_url || r.body.result.url, raw: r.body.result });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/jobs', (req, res) => {
  const spec = req.body;
  if (!Array.isArray(spec?.products) || !Array.isArray(spec?.patterns)) {
    return res.status(400).json({ error: 'products[] and patterns[] required' });
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
  const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
  const r = await printful.post('/files', { type: 'default', url: dataUrl, filename, visible: true });
  if (r.status !== 200) throw new Error('upload failed: ' + JSON.stringify(r.body).slice(0, 300));
  return { id: r.body.result.id, url: r.body.result.preview_url || r.body.result.url };
}

async function getCatalogDetail(catalogId) {
  return memo(`catalog-detail:${catalogId}`, 24 * 60 * 60 * 1000, async () => {
    const [info, pfRes] = await Promise.all([
      printful.get(`/products/${catalogId}`),
      printful.get(`/mockup-generator/printfiles/${catalogId}`),
    ]);
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

async function buildFilesForVariant(prod, pat, detail) {
  if (detail.wrap.kind === 'canvas-shoe') {
    const cacheKey = `shoe-build:${prod.id}:${pat.fileId}`;
    return memo(cacheKey, 60 * 60 * 1000, async () => {
      const patternBuf = await fetchPatternBuf(pat.url);
      const built = await buildShoeFiles(patternBuf, {
        quarter: detail.dims.shoe_quarters_left || { width: 2250, height: 2250 },
        tongue:  detail.dims.shoe_tongue_left   || { width: 2250, height: 2250 },
      });
      const safeName = (pat.label || 'pattern').replace(/[^a-z0-9]+/gi, '_');
      const [left, right, tongue] = await Promise.all([
        uploadBufferToPrintful(built.quarters_left,  `${safeName}_quarters_left.png`),
        uploadBufferToPrintful(built.quarters_right, `${safeName}_quarters_right.png`),
        built.tongue ? uploadBufferToPrintful(built.tongue, `${safeName}_tongue.png`) : null,
      ]);
      const files = [
        { type: 'shoe_quarters_left',  id: left.id },
        { type: 'shoe_quarters_right', id: right.id },
      ];
      if (tongue) {
        files.push({ type: 'shoe_tongue_left',  id: tongue.id });
        files.push({ type: 'shoe_tongue_right', id: tongue.id });
      }
      return files;
    });
  }
  // single-placement default fallback
  const primary = detail.placementNames[0] || 'default';
  return [{ type: primary, id: pat.fileId }];
}

async function runJob(job) {
  job.status = 'running';
  emit(job, { type: 'start', total: job.spec.products.length * job.spec.patterns.length });
  const { products, patterns, retailPrices = {} } = job.spec;

  for (const pat of patterns) {
    for (const prod of products) {
      const label = `${prod.title || prod.id} / ${pat.label}`;
      emit(job, { type: 'item-start', label });
      try {
        const detail = await getCatalogDetail(prod.id);
        emit(job, { type: 'item-info', label, wrap: detail.wrap.kind, placements: detail.placementNames });
        const variants = detail.info?.variants || [];
        const files = await buildFilesForVariant(prod, pat, detail);
        const sync_variants = variants.map(v => ({
          variant_id: v.id,
          retail_price: retailPrices[prod.id] || prod.retail || '29.00',
          files,
        }));
        const name = `${prod.title || `Product ${prod.id}`} - ${pat.label}`;
        const r = await printful.post('/store/products', {
          sync_product: { name, thumbnail: pat.url },
          sync_variants,
        });
        if (r.status === 200) {
          const id = r.body.result?.id;
          job.items.push({ label, ok: true, sync_id: id, wrap: detail.wrap.kind });
          emit(job, { type: 'item-ok', label, sync_id: id, wrap: detail.wrap.kind });
        } else {
          job.items.push({ label, ok: false, error: r.body });
          emit(job, { type: 'item-fail', label, error: r.body });
        }
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

app.listen(PORT, () => console.log(`jb-printful-api listening on :${PORT}`));

export { app, buildShoeFiles, fitToCanvas };
