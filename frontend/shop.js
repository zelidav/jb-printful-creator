const BACKEND = 'https://jb-printful-creator-915738985818.us-east1.run.app';
const state = {
  backend: BACKEND,
  pass: localStorage.getItem('jb-pass') || '',
  products: [],
};

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

async function api(path, opts = {}) {
  const res = await fetch(state.backend + path, {
    ...opts,
    headers: {
      'X-JB-Pass': state.pass,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 200)}`);
  return json;
}

$('#password').value = state.pass;

async function doLogin() {
  state.pass = $('#password').value;
  if (!state.pass) return;
  $('#login-msg').textContent = 'Loading catalog...';
  $('#login-msg').className = 'msg';
  try {
    const list = await api('/api/shop/products');
    localStorage.setItem('jb-pass', state.pass);
    state.products = list.items;
    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#auth-status').textContent = `${state.products.length} products`;
    renderGrid();
  } catch (e) {
    $('#login-msg').textContent = 'Login failed: ' + e.message;
    $('#login-msg').className = 'msg error';
  }
}

$('#login-btn').onclick = doLogin;
$('#password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

if (state.pass) doLogin();

function renderGrid() {
  const q = $('#search').value.toLowerCase();
  const filtered = q ? state.products.filter(p => (p.name || '').toLowerCase().includes(q)) : state.products;
  $('#count').textContent = filtered.length;
  const grid = $('#grid');
  grid.innerHTML = '';
  filtered.forEach(p => {
    const card = document.createElement('div');
    card.className = 'shop-card';
    card.innerHTML = `
      <img loading="lazy" src="${p.thumbnail || ''}" alt="">
      <div class="meta">
        <div class="name">${p.name}</div>
        <div class="price">${p.variant_count} variant${p.variant_count !== 1 ? 's' : ''}</div>
      </div>`;
    card.onclick = () => openOrderModal(p);
    grid.appendChild(card);
  });
}

let searchTimer;
$('#search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderGrid, 150); };

async function openOrderModal(productLite) {
  const host = $('#modal-host');
  host.innerHTML = `<div class="modal-bg" id="mb"><div class="modal"><p>Loading variants...</p></div></div>`;
  $('#mb').onclick = () => { host.innerHTML = ''; };
  let product;
  try {
    product = await api(`/api/shop/products/${productLite.id}`);
  } catch (e) {
    host.innerHTML = `<div class="modal-bg" id="mb"><div class="modal"><p>Couldn't load: ${e.message}</p></div></div>`;
    $('#mb').onclick = () => { host.innerHTML = ''; };
    return;
  }
  const sel = product.variants[0];
  if (!sel) { host.innerHTML = ''; alert('No variants available'); return; }
  host.innerHTML = `
    <div class="modal-bg" id="mb">
      <div class="modal" onclick="event.stopPropagation()">
        <img src="${product.thumbnail || ''}" alt="">
        <h2>${product.name}</h2>
        <label>Variant
          <select id="variant">
            ${product.variants.map(v => `<option value="${v.id}" data-price="${v.retail_price}">${v.name || (v.size + (v.color ? ' / ' + v.color : ''))} — $${v.retail_price}</option>`).join('')}
          </select>
        </label>
        <label>Quantity <input id="qty" type="number" value="1" min="1" max="10"></label>

        <hr style="border:none;border-top:1px solid var(--line);margin:16px 0;">
        <h3 style="margin:0 0 8px;font-size:14px;">Ship to</h3>
        <label>Your name <input id="emp-name" placeholder="Full name" required></label>
        <label>Your email <input id="emp-email" type="email" placeholder="for order updates"></label>
        <label>Address line 1 <input id="addr1" required></label>
        <label>Address line 2 <input id="addr2" placeholder="apt, unit, etc"></label>
        <div class="row">
          <label>City <input id="city" required></label>
          <label>State <input id="state" placeholder="2-letter, e.g. NY" maxlength="2" required></label>
        </div>
        <div class="row">
          <label>ZIP <input id="zip" required></label>
          <label>Country <input id="country" value="US" maxlength="2" required></label>
        </div>
        <label>Notes (optional) <textarea id="notes" rows="2" placeholder="anything for David"></textarea></label>

        <div class="total" id="modal-total">Estimated subtotal: $${(parseFloat(sel.retail_price) || 0).toFixed(2)}</div>
        <div class="actions">
          <button class="primary" id="submit-order">Place order</button>
          <button onclick="document.getElementById('modal-host').innerHTML=''">Cancel</button>
        </div>
        <div id="order-msg" class="msg"></div>
      </div>
    </div>`;
  $('#mb').onclick = () => { host.innerHTML = ''; };
  const upd = () => {
    const v = $('#variant').selectedOptions[0];
    const total = (parseFloat(v.dataset.price) || 0) * (parseInt($('#qty').value) || 1);
    $('#modal-total').textContent = `Estimated subtotal: $${total.toFixed(2)} (excl. shipping & tax)`;
  };
  $('#variant').onchange = upd;
  $('#qty').oninput = upd;
  $('#submit-order').onclick = () => submitOrder(product);
}

async function submitOrder(product) {
  const variant = $('#variant').value;
  const qty = parseInt($('#qty').value) || 1;
  const recipient = {
    name: $('#emp-name').value.trim(),
    email: $('#emp-email').value.trim() || undefined,
    address1: $('#addr1').value.trim(),
    address2: $('#addr2').value.trim() || undefined,
    city: $('#city').value.trim(),
    state_code: $('#state').value.trim().toUpperCase(),
    country_code: $('#country').value.trim().toUpperCase(),
    zip: $('#zip').value.trim(),
  };
  if (!recipient.name || !recipient.address1 || !recipient.city || !recipient.state_code || !recipient.zip) {
    $('#order-msg').textContent = 'Fill in all required fields';
    $('#order-msg').className = 'msg error';
    return;
  }
  $('#order-msg').textContent = 'Submitting...';
  $('#order-msg').className = 'msg';
  $('#submit-order').disabled = true;
  try {
    const r = await api('/api/shop/order', {
      method: 'POST',
      body: JSON.stringify({
        recipient,
        items: [{ sync_variant_id: parseInt(variant), quantity: qty }],
        employee_name: recipient.name,
        employee_email: recipient.email,
        notes: $('#notes').value.trim() || undefined,
      }),
    });
    if (r.status === 'confirmed') {
      $('#order-msg').textContent = `✓ Order placed (#${r.order_id}) — total $${r.total}. You'll get tracking by email when it ships.`;
      $('#order-msg').className = 'msg ok';
    } else if (r.status === 'pending_approval') {
      $('#order-msg').textContent = `✓ Order #${r.order_id} ($${r.total.toFixed(2)}) sent to David for approval. You'll get tracking once approved.`;
      $('#order-msg').className = 'msg ok';
    } else {
      $('#order-msg').textContent = JSON.stringify(r);
      $('#order-msg').className = 'msg error';
    }
  } catch (e) {
    $('#order-msg').textContent = e.message;
    $('#order-msg').className = 'msg error';
    $('#submit-order').disabled = false;
  }
}
