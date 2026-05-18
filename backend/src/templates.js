const TOKEN = process.env.PRINTFUL_TOKEN;
const SOURCE_STORE = process.env.STORE_ID;

async function callStore(storeId, method, path, body) {
  const res = await fetch('https://api.printful.com' + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'X-PF-Store-Id': storeId,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

export function attachTemplateRoutes(app, printful) {
  // List user's connected stores
  app.get('/api/stores', async (req, res) => {
    try {
      const r = await fetch('https://api.printful.com/stores', { headers: { Authorization: `Bearer ${TOKEN}` } });
      const j = await r.json();
      const stores = (j.result || []).map(s => ({ id: s.id, name: s.name, type: s.type }));
      res.json({ items: stores, source: SOURCE_STORE });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // List all templates (is_ignored=true sync_products in source store)
  app.get('/api/templates', async (req, res) => {
    try {
      const r = await printful.get('/store/products?limit=100');
      const items = (r.body?.result || [])
        .filter(p => p.is_ignored)
        .map(p => ({
          id: p.id,
          name: p.name,
          thumbnail: p.thumbnail_url,
          variant_count: p.variants,
        }));
      res.json({ count: items.length, items });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // Publish a template to a target store
  // - if target = source store: flip is_ignored=false (it becomes live in Internal Store)
  // - if target = different store: clone the product into that store as a new sync_product
  app.post('/api/templates/:id/publish', async (req, res) => {
    try {
      const id = req.params.id;
      const { target_store_id } = req.body || {};
      if (!target_store_id) return res.status(400).json({ error: 'target_store_id required' });

      const src = await printful.get(`/store/products/${id}`);
      if (src.status !== 200) return res.status(404).json({ error: 'template not found' });
      const sp = src.body.result.sync_product;
      const sv = src.body.result.sync_variants;

      if (String(target_store_id) === String(SOURCE_STORE)) {
        // Same store: just unhide
        const upd = await printful.put(`/store/products/${id}`, { sync_product: { is_ignored: false } });
        if (upd.status !== 200) return res.status(500).json({ error: 'unhide failed', detail: upd.body });
        return res.json({ status: 'unhidden', id, target_store_id });
      }

      // Cross-store: POST to target store as new sync_product
      const payload = {
        sync_product: { name: sp.name, thumbnail: sp.thumbnail_url, is_ignored: false },
        sync_variants: sv.map(v => ({
          variant_id: v.variant_id,
          retail_price: v.retail_price,
          files: (v.files || []).filter(f => f.type !== 'preview').map(f => ({
            type: f.type,
            id: f.id,
            ...(f.options ? { options: f.options } : {}),
          })),
        })),
      };
      const clone = await callStore(target_store_id, 'POST', '/store/products', payload);
      if (clone.status !== 200) return res.status(500).json({ error: 'clone failed', detail: clone.body });
      res.json({ status: 'cloned', id, target_store_id, new_id: clone.body.result.id });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.delete('/api/templates/:id', async (req, res) => {
    try {
      const r = await printful.del(`/store/products/${req.params.id}`);
      if (r.status !== 200) return res.status(500).json({ error: 'delete failed', detail: r.body });
      res.json({ status: 'deleted', id: req.params.id });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });
}
