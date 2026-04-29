const BACKEND = 'https://jb-printful-creator-915738985818.us-east1.run.app';
const state = {
  backend: BACKEND,
  pass: localStorage.getItem('jb-pass') || '',
  products: [],
  cart: JSON.parse(localStorage.getItem('jb-cart') || '[]'),
};

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

function saveCart() { localStorage.setItem('jb-cart', JSON.stringify(state.cart)); }

async function api(path, opts = {}) {
  const res = await fetch(state.backend + path, {
    ...opts,
    headers: {
      'X-JB-Pass': state.pass,
      ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(json.error || `${res.status}: ${text.slice(0, 200)}`);
  return json;
}

// ---------- LOGIN ----------
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
    updateCartCount();
  } catch (e) {
    $('#login-msg').textContent = 'Login failed: ' + e.message;
    $('#login-msg').className = 'msg error';
  }
}

$('#login-btn').onclick = doLogin;
$('#password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
if (state.pass) doLogin();

// ---------- GRID ----------
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
    card.onclick = () => openProductModal(p);
    grid.appendChild(card);
  });
}

let searchTimer;
$('#search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderGrid, 150); };

// ---------- PRODUCT MODAL (Add to cart) ----------
async function openProductModal(productLite) {
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
            ${product.variants.map(v => `<option value="${v.id}" data-price="${v.retail_price}" data-name="${(v.name || '').replace(/"/g, '&quot;')}">${v.name || (v.size + (v.color ? ' / ' + v.color : ''))} — $${v.retail_price}</option>`).join('')}
          </select>
        </label>
        <label>Quantity <input id="qty" type="number" value="1" min="1" max="10"></label>
        <div class="total" id="modal-total">$${(parseFloat(sel.retail_price) || 0).toFixed(2)}</div>
        <div class="actions">
          <button class="primary" id="add-cart">Add to cart</button>
          <button onclick="document.getElementById('modal-host').innerHTML=''">Cancel</button>
        </div>
        <div id="modal-msg" class="msg"></div>
      </div>
    </div>`;
  $('#mb').onclick = () => { host.innerHTML = ''; };
  const upd = () => {
    const v = $('#variant').selectedOptions[0];
    const total = (parseFloat(v.dataset.price) || 0) * (parseInt($('#qty').value) || 1);
    $('#modal-total').textContent = '$' + total.toFixed(2);
  };
  $('#variant').onchange = upd;
  $('#qty').oninput = upd;
  $('#add-cart').onclick = () => {
    const v = $('#variant').selectedOptions[0];
    const qty = parseInt($('#qty').value) || 1;
    addToCart({
      sync_product_id: product.id,
      product_name: product.name,
      thumbnail: product.thumbnail,
      sync_variant_id: parseInt(v.value),
      variant_name: v.dataset.name,
      retail_price: parseFloat(v.dataset.price) || 0,
      quantity: qty,
    });
    host.innerHTML = '';
    openCart();
  };
}

// ---------- CART ----------
function addToCart(item) {
  // merge if same variant already in cart
  const existing = state.cart.find(c => c.sync_variant_id === item.sync_variant_id);
  if (existing) existing.quantity += item.quantity;
  else state.cart.push(item);
  saveCart();
  updateCartCount();
  renderCart();
}

function updateCartCount() {
  const total = state.cart.reduce((sum, i) => sum + i.quantity, 0);
  $('#cart-count').textContent = total;
}

function openCart() {
  renderCart();
  $('#cart-drawer').hidden = false;
}
function closeCart() { $('#cart-drawer').hidden = true; }
$('#cart-btn').onclick = openCart;
$('#cart-close').onclick = closeCart;
$('#cart-overlay').onclick = closeCart;

function renderCart() {
  const items = $('#cart-items');
  items.innerHTML = '';
  if (!state.cart.length) {
    items.innerHTML = '<div class="cart-empty">Cart empty</div>';
    $('#cart-subtotal').textContent = '$0.00';
    $('#checkout-btn').disabled = true;
    return;
  }
  let subtotal = 0;
  state.cart.forEach((it, i) => {
    subtotal += (it.retail_price || 0) * it.quantity;
    const div = document.createElement('div');
    div.className = 'cart-item';
    div.innerHTML = `
      <img src="${it.thumbnail || ''}" alt="">
      <div class="info">
        <div class="name">${it.product_name}</div>
        <div class="variant">${it.variant_name}</div>
        <div class="price">$${(it.retail_price || 0).toFixed(2)} each</div>
        <div class="qty-row">
          <button data-i="${i}" data-d="-1">−</button>
          <span>${it.quantity}</span>
          <button data-i="${i}" data-d="1">+</button>
          <button class="remove" data-i="${i}">Remove</button>
        </div>
      </div>`;
    items.appendChild(div);
  });
  $('#cart-subtotal').textContent = '$' + subtotal.toFixed(2);
  $('#checkout-btn').disabled = false;

  items.querySelectorAll('button[data-d]').forEach(b => {
    b.onclick = () => {
      const i = parseInt(b.dataset.i), d = parseInt(b.dataset.d);
      state.cart[i].quantity = Math.max(1, state.cart[i].quantity + d);
      saveCart(); updateCartCount(); renderCart();
    };
  });
  items.querySelectorAll('.remove').forEach(b => {
    b.onclick = () => {
      state.cart.splice(parseInt(b.dataset.i), 1);
      saveCart(); updateCartCount(); renderCart();
    };
  });
}

// ---------- CHECKOUT ----------
$('#checkout-btn').onclick = openCheckoutForm;

function openCheckoutForm() {
  const host = $('#modal-host');
  host.innerHTML = `
    <div class="modal-bg" id="mb">
      <div class="modal" onclick="event.stopPropagation()">
        <h2>Checkout</h2>
        <p class="muted" style="margin:0 0 12px;">Ships everything in your cart to one address.</p>
        <label>Your name <input id="emp-name" placeholder="Full name" required></label>
        <label>Your email <input id="emp-email" type="email" placeholder="for order updates"></label>
        <label>Address line 1 <input id="addr1" required></label>
        <label>Address line 2 <input id="addr2" placeholder="apt, unit"></label>
        <div class="row">
          <label>City <input id="city" required></label>
          <label>State <input id="state" placeholder="NY" maxlength="2" required></label>
        </div>
        <div class="row">
          <label>ZIP <input id="zip" required></label>
          <label>Country <input id="country" value="US" maxlength="2" required></label>
        </div>
        <label>Notes <textarea id="notes" rows="2" placeholder="optional"></textarea></label>
        <div class="actions">
          <button class="primary" id="place-order">Place order</button>
          <button onclick="document.getElementById('modal-host').innerHTML=''">Cancel</button>
        </div>
        <div id="order-msg" class="msg"></div>
      </div>
    </div>`;
  $('#mb').onclick = () => { host.innerHTML = ''; };
  $('#place-order').onclick = submitOrder;
}

async function submitOrder() {
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
    $('#order-msg').textContent = 'Fill all required fields'; $('#order-msg').className = 'msg error'; return;
  }
  $('#order-msg').textContent = 'Submitting...';
  $('#order-msg').className = 'msg';
  $('#place-order').disabled = true;
  try {
    const r = await api('/api/shop/order', {
      method: 'POST',
      body: JSON.stringify({
        recipient,
        items: state.cart.map(i => ({ sync_variant_id: i.sync_variant_id, quantity: i.quantity })),
        employee_name: recipient.name,
        employee_email: recipient.email,
        notes: $('#notes').value.trim() || undefined,
      }),
    });
    if (r.status === 'confirmed') {
      $('#order-msg').textContent = `✓ Order placed (#${r.order_id}) — $${r.total}. Tracking will be emailed when it ships.`;
      $('#order-msg').className = 'msg ok';
    } else if (r.status === 'pending_approval') {
      $('#order-msg').textContent = `✓ Order #${r.order_id} ($${r.total.toFixed(2)}) sent to David for approval.`;
      $('#order-msg').className = 'msg ok';
    }
    state.cart = [];
    saveCart();
    updateCartCount();
    closeCart();
  } catch (e) {
    $('#order-msg').textContent = 'Order failed: ' + e.message;
    $('#order-msg').className = 'msg error';
    $('#place-order').disabled = false;
  }
}
