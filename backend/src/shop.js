import crypto from 'crypto';
import { sendEmail } from './email.js';
import { memo } from './cache.js';

const APPROVAL_THRESHOLD = parseFloat(process.env.APPROVAL_THRESHOLD || '150');
const APPROVER_EMAIL = process.env.APPROVER_EMAIL || 'david@canismajorpartners.com';
const TOKEN_SECRET = process.env.TOKEN_SECRET || process.env.APP_PASSWORD || 'fallback-secret';

function token(orderId, action) {
  return crypto.createHmac('sha256', TOKEN_SECRET).update(`${action}:${orderId}`).digest('base64url');
}
function verify(orderId, action, candidate) {
  const expected = token(orderId, action);
  return candidate.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}

export function attachShopRoutes(app, printful) {
  // Public catalog of native-store sync products with retail prices
  app.get('/api/shop/products', async (req, res) => {
    try {
      const data = await memo('shop:list', 5 * 60 * 1000, async () => {
        const list = await printful.get('/store/products?limit=100');
        const items = list.body?.result || [];
        // Fetch each product's variants for retail price + size options
        const detailed = [];
        for (const p of items) {
          const d = await printful.get(`/store/products/${p.id}`);
          const variants = (d.body?.result?.sync_variants || []).map(v => ({
            id: v.id,
            variant_id: v.variant_id,
            name: v.name,
            retail_price: v.retail_price,
            size: v.size,
            color: v.color,
            availability_status: v.availability_status,
          }));
          detailed.push({
            id: p.id,
            name: p.name,
            thumbnail: p.thumbnail_url,
            min_price: variants.length ? Math.min(...variants.map(v => parseFloat(v.retail_price) || 0)) : 0,
            variants,
          });
        }
        return detailed;
      });
      res.json({ count: data.length, items: data });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // Place an order. Auto-confirms if total <= threshold, else emails approver.
  app.post('/api/shop/order', async (req, res) => {
    try {
      const { recipient, items, employee_name, employee_email, notes } = req.body;
      if (!recipient || !Array.isArray(items) || !items.length) {
        return res.status(400).json({ error: 'recipient and items[] required' });
      }
      const orderRes = await printful.post('/orders', {
        recipient,
        items: items.map(i => ({ sync_variant_id: i.sync_variant_id, quantity: i.quantity || 1 })),
        external_id: `jbdgear-${Date.now()}`,
      });
      if (orderRes.status !== 200) {
        return res.status(500).json({ error: 'printful order create failed', detail: orderRes.body });
      }
      const order = orderRes.body.result;
      const total = parseFloat(order.costs?.total || '0');

      if (total <= APPROVAL_THRESHOLD) {
        const conf = await printful.post(`/orders/${order.id}/confirm`);
        if (conf.status !== 200) {
          return res.status(500).json({ error: 'printful confirm failed', detail: conf.body });
        }
        return res.json({ status: 'confirmed', order_id: order.id, total });
      }

      // Over threshold — keep as draft, email approver
      const approveTok = token(order.id, 'approve');
      const denyTok = token(order.id, 'deny');
      const base = `${req.protocol}://${req.get('host')}`;
      const approveUrl = `${base}/api/shop/approve/${order.id}/${approveTok}`;
      const denyUrl = `${base}/api/shop/deny/${order.id}/${denyTok}`;

      const lines = order.items.map(i =>
        `<li>${i.quantity}× ${i.name} — $${i.retail_price}</li>`
      ).join('');
      const addr = `${recipient.name}<br>${recipient.address1}${recipient.address2 ? '<br>' + recipient.address2 : ''}<br>${recipient.city}, ${recipient.state_code} ${recipient.zip}<br>${recipient.country_code}`;
      const html = `
        <h2>JBD Gear order — approval needed ($${total.toFixed(2)})</h2>
        ${employee_name ? `<p><strong>Employee:</strong> ${employee_name}${employee_email ? ` (${employee_email})` : ''}</p>` : ''}
        ${notes ? `<p><strong>Notes:</strong> ${notes}</p>` : ''}
        <h3>Items</h3>
        <ul>${lines}</ul>
        <h3>Costs</h3>
        <table cellpadding="4">
          <tr><td>Subtotal</td><td>$${order.costs?.subtotal}</td></tr>
          <tr><td>Shipping</td><td>$${order.costs?.shipping}</td></tr>
          <tr><td>Tax</td><td>$${order.costs?.tax}</td></tr>
          <tr><td>VAT</td><td>$${order.costs?.vat}</td></tr>
          <tr><td><strong>Total</strong></td><td><strong>$${order.costs?.total}</strong></td></tr>
        </table>
        <h3>Ship to</h3>
        <p>${addr}</p>
        <p style="margin-top:24px;">
          <a href="${approveUrl}" style="background:#22c55e;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:600;">Approve & charge</a>
          &nbsp;&nbsp;
          <a href="${denyUrl}" style="background:#ef4444;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:600;">Deny & cancel</a>
        </p>
        <p style="color:#888;font-size:12px;">Printful order #${order.id} — currently a draft, will be charged to your stored card on Approve.</p>
      `;

      try {
        await sendEmail({ to: APPROVER_EMAIL, subject: `[$${total.toFixed(2)}] JBD Gear approval — ${employee_name || 'employee'}`, html });
      } catch (e) {
        console.error('email send failed:', e);
      }

      res.json({ status: 'pending_approval', order_id: order.id, total });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.get('/api/shop/approve/:id/:token', async (req, res) => {
    const { id, token: tok } = req.params;
    if (!verify(id, 'approve', tok)) return res.status(403).send('Invalid or expired link.');
    const r = await printful.post(`/orders/${id}/confirm`);
    if (r.status !== 200) return res.status(500).send('Confirm failed: ' + JSON.stringify(r.body).slice(0, 300));
    res.send(`<!doctype html><html><body style="font:14px sans-serif;background:#0e0f12;color:#eee;padding:40px;">
      <h2 style="color:#4dffc1;">Approved &amp; charged ✓</h2>
      <p>Printful order #${id} confirmed. The employee will get tracking by email when it ships.</p>
      </body></html>`);
  });

  app.get('/api/shop/deny/:id/:token', async (req, res) => {
    const { id, token: tok } = req.params;
    if (!verify(id, 'deny', tok)) return res.status(403).send('Invalid or expired link.');
    const r = await printful.del(`/orders/${id}`);
    if (r.status !== 200) return res.status(500).send('Cancel failed: ' + JSON.stringify(r.body).slice(0, 300));
    res.send(`<!doctype html><html><body style="font:14px sans-serif;background:#0e0f12;color:#eee;padding:40px;">
      <h2 style="color:#ff5d6c;">Denied &amp; canceled ✓</h2>
      <p>Printful order #${id} canceled. No charge.</p>
      </body></html>`);
  });
}
