const BACKEND = 'https://jb-printful-creator-915738985818.us-east1.run.app';
const state = {
  backend: BACKEND,
  pass: localStorage.getItem('jb-pass') || '',
  catalog: [],
  selected: new Map(),  // catalog_id -> product
  designs: [           // up to 3 designs, each with a pattern + matching logo
    { label: '', pattern: null, logo: null },
  ],
  wrapInfo: new Map(),  // catalog_id -> { wrap, placements, templates }
  wrapChoices: new Map(), // catalog_id -> 'tile' | 'mirror' | 'separate'
  prices: {},           // catalog_id -> min blank price (loaded async)
  sort: 'featured',     // 'featured' | 'price-asc' | 'price-desc'
};

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

async function api(path, opts = {}) {
  const res = await fetch(state.backend + path, {
    ...opts,
    headers: {
      'X-JB-Pass': state.pass,
      ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ---------- LOGIN ----------
$('#password').value = state.pass;

async function doLogin() {
  state.pass = $('#password').value;
  if (!state.pass) return;
  $('#login-msg').textContent = 'Connecting...';
  $('#login-msg').className = 'msg';
  try {
    const cat = await api('/api/catalog');
    localStorage.setItem('jb-pass', state.pass);
    state.catalog = cat.items;
    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#auth-status').textContent = `${state.catalog.length} catalog items loaded`;
    renderCatalog();
    // Prices load in the background (per-product on the server, cached) — enable price sort when ready.
    api('/api/catalog/prices').then(r => {
      state.prices = r.prices || {};
      const sortSel = document.getElementById('catalog-sort');
      if (sortSel) sortSel.querySelectorAll('option[value^="price"]').forEach(o => { o.disabled = false; });
      renderCatalog();
    }).catch(() => {});
  } catch (e) {
    $('#login-msg').textContent = 'Login failed: ' + e.message;
    $('#login-msg').className = 'msg error';
  }
}
$('#login-btn').onclick = doLogin;
$('#password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

if (state.pass) doLogin();

// ---------- STEP NAV ----------
function goToStep(name) {
  $$('.steps button').forEach(x => x.classList.remove('active'));
  $$('.step').forEach(x => x.classList.remove('active'));
  $$('.steps button').forEach(b => { if (b.dataset.step === name) b.classList.add('active'); });
  $('#step-' + name).classList.add('active');
  if (name === 'patterns') renderPatterns();
  if (name === 'review') renderReview();
  updateSelTray();
}
$$('.steps button').forEach(b => { b.onclick = () => goToStep(b.dataset.step); });
const toReviewBtn = document.getElementById('to-review');
if (toReviewBtn) toReviewBtn.onclick = () => goToStep('review');

// Sticky selected-products tray (only on the Products step)
function updateSelTray() {
  const tray = $('#sel-tray');
  if (!tray) return;
  const n = state.selected.size;
  const onProducts = $('#step-products')?.classList.contains('active');
  tray.hidden = n === 0 || !onProducts;
  $('#sel-tray-text').textContent = `${n} product${n !== 1 ? 's' : ''} selected`;
}
$('#sel-next')?.addEventListener('click', () => goToStep('patterns'));
$('#sel-clear')?.addEventListener('click', () => { state.selected.clear(); renderCatalog(); });

// ---------- CATALOG ----------
function makeProductCard(p) {
  const isSel = state.selected.has(p.id);
  const card = document.createElement('div');
  card.className = 'product-card' + (isSel ? ' selected' : '');
  const price = state.prices[p.id];
  card.innerHTML = `
    <div class="sel-check" aria-hidden="true">✓</div>
    <img loading="lazy" src="${p.image || ''}" alt="">
    <div class="meta">
      <div class="title">${p.title || 'Untitled'}</div>
      <div class="brand">${p.brand || ''}</div>
      <span class="badge">#${p.id}</span>
      ${price != null ? `<span class="badge price">from $${price.toFixed(2)}</span>` : ''}
    </div>`;
  card.onclick = () => {
    if (state.selected.has(p.id)) state.selected.delete(p.id);
    else state.selected.set(p.id, p);
    renderCatalog();
  };
  return card;
}

// Map raw product fields → friendly group names
function friendlyGroup(p) {
  const title = (p.title || '').toLowerCase();
  const type = (p.type || '').toLowerCase();
  const all = title + ' ' + type;

  if (/sock|underwear|brief|boxer|panty|thong|bra|undergarment/.test(all)) return 'Undergarments';
  if (/short|biker|jogger/.test(all)) return 'Shorts & Bottoms';
  if (/legging|tights|pant|sweatpant/.test(all)) return 'Shorts & Bottoms';
  if (/tee|t-shirt|tank|polo|long.?sleeve|jersey|shirt/.test(all)) return 'Shirts';
  if (/hoodie|sweatshirt|sweater|crewneck|fleece/.test(all)) return 'Hoodies & Sweatshirts';
  if (/dress|skirt|jumpsuit|romper/.test(all)) return 'Dresses & Skirts';
  if (/shoe|sneaker|slip-on|boot|sandal|flip|flop|footwear/.test(all)) return 'Shoes';
  if (/hat|cap|beanie|visor|bucket/.test(all)) return 'Hats';
  if (/bag|tote|backpack|fanny|pouch|duffle/.test(all)) return 'Bags';
  if (/phone|case|sleeve|laptop|tablet|airpod|ipad/.test(all)) return 'Tech & Cases';
  if (/mug|bottle|tumbler|drinkware|cup/.test(all)) return 'Drinkware';
  if (/towel|blanket|throw|pillow|cushion|cover/.test(all)) return 'Home Textiles';
  if (/poster|canvas|sticker|magnet|notebook|journal|mousepad|mouse pad|coaster|notepad|wall.?art/.test(all)) return 'Decor & Stationery';
  if (/jewelry|necklace|earring|bracelet|ring|chain|charm|pin/.test(all)) return 'Jewelry & Pins';
  if (/wallet|keychain|lanyard|bandana|scrunchie|scarf|gloves|belt/.test(all)) return 'Accessories';
  if (/baby|infant|kid|youth|toddler|onesie/.test(all)) return 'Kids & Baby';
  return 'Other';
}

const GROUP_ORDER = [
  'Shirts',
  'Hoodies & Sweatshirts',
  'Shorts & Bottoms',
  'Dresses & Skirts',
  'Undergarments',
  'Shoes',
  'Hats',
  'Bags',
  'Tech & Cases',
  'Drinkware',
  'Home Textiles',
  'Jewelry & Pins',
  'Accessories',
  'Kids & Baby',
  'Decor & Stationery',
  'Other',
];

function renderCatalog() {
  const q = $('#catalog-search').value.toLowerCase();
  const filtered = q
    ? state.catalog.filter(p => (p.title || '').toLowerCase().includes(q) || (p.brand || '').toLowerCase().includes(q) || (p.type || '').toLowerCase().includes(q))
    : state.catalog;
  $('#catalog-count').textContent = filtered.length;
  $('#selected-count').textContent = state.selected.size;
  const grid = $('#catalog-grid');
  grid.innerHTML = '';

  updateSelTray();

  // Price sort → flat list (groups don't apply); products without a known price sort last.
  if (state.sort === 'price-asc' || state.sort === 'price-desc') {
    const dir = state.sort === 'price-asc' ? 1 : -1;
    const priced = [...filtered].sort((a, b) => {
      const pa = state.prices[a.id], pb = state.prices[b.id];
      if (pa == null && pb == null) return 0;
      if (pa == null) return 1;
      if (pb == null) return -1;
      return (pa - pb) * dir;
    });
    priced.forEach(p => grid.appendChild(makeProductCard(p)));
    return;
  }

  if (q) {
    filtered.forEach(p => grid.appendChild(makeProductCard(p)));
    return;
  }

  const groups = new Map();
  for (const p of filtered) {
    const g = friendlyGroup(p);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  // Render in our defined order, then any leftovers
  const seen = new Set();
  for (const name of GROUP_ORDER) {
    if (!groups.has(name)) continue;
    seen.add(name);
    const items = groups.get(name);
    const header = document.createElement('div');
    header.className = 'catalog-group';
    header.textContent = `${name} · ${items.length}`;
    grid.appendChild(header);
    items.forEach(p => grid.appendChild(makeProductCard(p)));
  }
  for (const [name, items] of groups) {
    if (seen.has(name)) continue;
    const header = document.createElement('div');
    header.className = 'catalog-group';
    header.textContent = `${name} · ${items.length}`;
    grid.appendChild(header);
    items.forEach(p => grid.appendChild(makeProductCard(p)));
  }
}

let catalogTimer;
$('#catalog-search').oninput = () => {
  clearTimeout(catalogTimer);
  catalogTimer = setTimeout(renderCatalog, 150);
};
const catalogSort = document.getElementById('catalog-sort');
if (catalogSort) catalogSort.onchange = () => { state.sort = catalogSort.value; renderCatalog(); };

// ---------- DESIGN SLOTS (pattern + logo per design) ----------
async function uploadOne(file) {
  const fd = new FormData(); fd.append('file', file);
  return api('/api/upload', { method: 'POST', body: fd });
}

let dropPatternCache = null;
async function fetchDropPatterns() {
  if (!dropPatternCache) {
    const r = await api('/api/drop-patterns');
    dropPatternCache = r.items || [];
  }
  return dropPatternCache;
}

async function ingestUrlAsPattern(item) {
  const r = await api('/api/ingest-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: item.url, filename: item.file }),
  });
  const dim = await new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = item.url;
  });
  return {
    name: item.label,
    dataUrl: item.url,
    dim,
    fileId: r.id,
    url: r.url,
  };
}

// Multi-select drop picker. Calls onPickMany([{pattern, logo}]) — one entry per selected art,
// each with its strain logo auto-paired. The caller turns each into its own design.
async function openDropPicker(onPickMany) {
  const items = await fetchDropPatterns();
  const modal = document.createElement('div');
  modal.className = 'drop-modal';
  const groups = {};
  for (const it of items) (groups[it.dropLabel] = groups[it.dropLabel] || []).push(it);
  const groupHtml = Object.entries(groups).map(([drop, list]) => `
    <div class="drop-group">
      <h3>${drop}</h3>
      <div class="drop-grid">
        ${list.map(it => `
          <div class="drop-card" data-idx="${items.indexOf(it)}">
            <div class="drop-check" aria-hidden="true">✓</div>
            <img src="${it.url}" alt="${it.label}">
            <div class="drop-label">${it.label}${it.lowRes ? ' <span class="lowres">LOW RES</span>' : ''}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
  modal.innerHTML = `
    <div class="drop-modal-inner">
      <div class="drop-modal-head">
        <h2>JBD Drop Patterns</h2>
        <button class="drop-close">×</button>
      </div>
      <div class="drop-modal-body">${groupHtml}</div>
      <div class="drop-modal-foot">
        <span class="muted">Click to select one or more — each becomes its own design.</span>
        <button class="primary drop-add" disabled>Add design</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('.drop-close').onclick = close;
  modal.onclick = e => { if (e.target === modal) close(); };

  const selected = new Set();
  const addBtn = modal.querySelector('.drop-add');
  const refresh = () => {
    addBtn.disabled = selected.size === 0;
    addBtn.textContent = selected.size ? `Add ${selected.size} design${selected.size > 1 ? 's' : ''}` : 'Add design';
  };
  modal.querySelectorAll('.drop-card').forEach(card => {
    card.onclick = () => {
      const idx = parseInt(card.dataset.idx);
      if (selected.has(idx)) { selected.delete(idx); card.classList.remove('selected'); }
      else { selected.add(idx); card.classList.add('selected'); }
      refresh();
    };
  });
  addBtn.onclick = async () => {
    if (!selected.size) return;
    addBtn.disabled = true;
    const picks = [];
    let done = 0;
    for (const idx of selected) {
      const it = items[idx];
      addBtn.textContent = `Ingesting ${++done}/${selected.size}…`;
      try {
        const pattern = await ingestUrlAsPattern(it);
        let logo = null;
        if (it.logo?.url) logo = await ingestUrlAsPattern({ url: it.logo.url, file: it.logo.file, label: it.logo.label });
        picks.push({ pattern, logo });
      } catch (err) { /* skip an art that fails to ingest */ }
    }
    close();
    onPickMany(picks);
  };
}

let logoLibCache = null;
async function fetchLogos() {
  if (!logoLibCache) { const r = await api('/api/logos'); logoLibCache = r.items || []; }
  return logoLibCache;
}

// Single-select logo picker (the shared logo library — graffiti icon + strain logos).
async function openLogoPicker(onPick) {
  const items = await fetchLogos();
  const modal = document.createElement('div');
  modal.className = 'drop-modal';
  modal.innerHTML = `
    <div class="drop-modal-inner">
      <div class="drop-modal-head"><h2>Logos</h2><button class="drop-close">×</button></div>
      <div class="drop-modal-body"><div class="drop-grid">
        ${items.map((it, i) => `
          <div class="drop-card logo-card" data-idx="${i}">
            <img src="${it.url}" alt="${it.label}">
            <div class="drop-label">${it.label}</div>
          </div>`).join('')}
      </div></div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('.drop-close').onclick = close;
  modal.onclick = e => { if (e.target === modal) close(); };
  modal.querySelectorAll('.drop-card').forEach(card => {
    card.onclick = async () => {
      const it = items[parseInt(card.dataset.idx)];
      card.classList.add('loading');
      card.insertAdjacentHTML('beforeend', '<div class="loading-overlay">Ingesting…</div>');
      try {
        const data = await ingestUrlAsPattern({ url: it.url, file: it.file.split('/').pop(), label: it.label });
        close();
        onPick(data);
      } catch (err) {
        card.querySelector('.loading-overlay').textContent = 'Failed: ' + err.message;
      }
    };
  });
}

function dpiClass(dim, role) {
  // role: 'pattern' (needs ~2000) or 'logo' (needs ~800)
  const min = role === 'logo' ? 800 : 2000;
  const ok  = role === 'logo' ? 1500 : 3000;
  if (!dim) return '';
  const m = Math.min(dim.w, dim.h);
  if (m >= ok) return '';
  if (m >= min) return 'warn';
  return 'bad';
}

function dpiNote(dim, role) {
  if (!dim) return '';
  const cls = dpiClass(dim, role);
  if (!cls) return `${dim.w}×${dim.h}`;
  if (cls === 'warn') return `${dim.w}×${dim.h} · soft on large prints`;
  return `${dim.w}×${dim.h} · TOO LOW — will blur`;
}

async function readImageDimensions(file) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = URL.createObjectURL(file);
  });
}

async function pickAndUpload(role, slotEl, onDone) {
  const inp = slotEl.querySelector('input[type=file]');
  inp.onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    const dataUrl = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
    const dim = await readImageDimensions(file);
    slotEl.querySelector('.hint').textContent = 'Uploading...';
    try {
      const r = await uploadOne(file);
      onDone({ name: file.name.replace(/\.[^.]+$/, ''), dataUrl, dim, fileId: r.id, url: r.url });
    } catch (err) {
      slotEl.querySelector('.hint').textContent = 'Upload failed: ' + err.message;
    }
  };
}

function ensureSlots() {
  // Keep one trailing empty slot so more designs can always be added (multiselect can add many).
  const MAX = 24;
  const last = state.designs[state.designs.length - 1];
  if (state.designs.length < MAX && last && (last.pattern || last.logo || last.label)) {
    state.designs.push({ label: '', pattern: null, logo: null });
  }
}

function renderUploadCell(role, design, idx) {
  const cell = document.createElement('div');
  const item = design[role]; // pattern or logo
  cell.className = 'upload-cell' + (item ? ' filled' : '');
  if (item) {
    cell.innerHTML = `
      <div class="label">${role}</div>
      <img src="${item.dataUrl}">
      <div class="dim ${dpiClass(item.dim, role)}">${dpiNote(item.dim, role)}</div>
      <button style="margin-top:8px">Remove ${role}</button>`;
    cell.querySelector('button').onclick = () => { state.designs[idx][role] = null; renderPatterns(); };
  } else {
    const browseHtml = role === 'pattern'
      ? `<button class="browse-drops" type="button" style="margin-top:6px;font-size:11px;padding:4px 8px;">Browse JBD drops</button>`
      : `<button class="browse-logos" type="button" style="margin-top:6px;font-size:11px;padding:4px 8px;">Browse logos</button>`;
    cell.innerHTML = `
      <div class="label">${role}</div>
      <div class="hint">Pick a ${role} (drop or click)</div>
      <input type="file" accept="image/*" style="margin-top:8px">
      ${browseHtml}`;
    pickAndUpload(role, cell, (data) => {
      state.designs[idx][role] = data;
      if (!state.designs[idx].label) state.designs[idx].label = data.name;
      renderPatterns();
    });
    const browseBtn = cell.querySelector('.browse-drops');
    if (browseBtn) browseBtn.onclick = () => openDropPicker(picks => {
      // First pick fills this slot; the rest are appended as their own designs.
      picks.forEach((pk, k) => {
        const target = k === 0 ? state.designs[idx] : { label: '', pattern: null, logo: null };
        target.pattern = pk.pattern;
        if (pk.logo) target.logo = pk.logo;  // strain logo auto-paired
        if (!target.label) target.label = pk.pattern.name;
        if (k > 0) state.designs.push(target);
      });
      renderPatterns();
    });
    const logoBtn = cell.querySelector('.browse-logos');
    if (logoBtn) logoBtn.onclick = () => openLogoPicker(data => {
      state.designs[idx].logo = data;
      renderPatterns();
    });
  }
  return cell;
}

function renderPatterns() {
  ensureSlots();
  const wrap = $('#design-slots');
  wrap.innerHTML = '';
  state.designs.forEach((d, i) => {
    const slot = document.createElement('div');
    const isFilled = d.pattern || d.logo || d.label;
    slot.className = 'design-slot' + (isFilled ? ' filled' : '');

    const labelRow = document.createElement('div');
    labelRow.className = 'label-row';
    labelRow.innerHTML = `<input type="text" placeholder="Design label (e.g. Indica)" value="${d.label || ''}">`;
    labelRow.querySelector('input').oninput = e => { d.label = e.target.value; };
    slot.appendChild(labelRow);

    const uploadRow = document.createElement('div');
    uploadRow.className = 'upload-row';
    uploadRow.appendChild(renderUploadCell('pattern', d, i));
    uploadRow.appendChild(renderUploadCell('logo', d, i));
    slot.appendChild(uploadRow);

    if (isFilled && state.designs.length > 1) {
      const rm = document.createElement('button');
      rm.className = 'remove-design';
      rm.textContent = 'Remove this design';
      rm.onclick = () => { state.designs.splice(i, 1); if (state.designs.length === 0) state.designs = [{ label: '', pattern: null, logo: null }]; renderPatterns(); };
      slot.appendChild(rm);
    }

    wrap.appendChild(slot);
  });
}

// ---------- REVIEW ----------
async function renderReview() {
  const sel = Array.from(state.selected.values());
  const pats = state.designs.filter(d => d.pattern?.fileId || d.logo?.fileId);

  // Pre-fetch wrap info for selected products
  $('#review-summary').innerHTML = '<div class="muted">Inspecting products for wrap-around layouts...</div>';
  for (const prod of sel) {
    if (!state.wrapInfo.has(prod.id)) {
      try {
        const info = await api(`/api/catalog/${prod.id}`);
        state.wrapInfo.set(prod.id, info);
      } catch (e) {
        state.wrapInfo.set(prod.id, { wrap: { kind: 'single', panels: [] } });
      }
    }
  }

  const total = sel.length * pats.length;

  // Designs strip — show each design's pattern + paired logo
  const designsHtml = pats.length ? `
    <div class="review-block">
      <h3>${pats.length} design${pats.length > 1 ? 's' : ''}</h3>
      <div class="design-strip">
        ${pats.map(d => `
          <div class="design-chip">
            <div class="design-chip-imgs">
              <img src="${(d.pattern || d.logo).dataUrl}" alt="" title="${d.pattern ? 'pattern' : 'logo'}">
              ${d.pattern && d.logo ? `<img src="${d.logo.dataUrl}" class="logo" alt="" title="logo">` : ''}
            </div>
            <div class="design-chip-label">${d.label || d.pattern?.name || d.logo?.name || 'Design'}${!d.pattern ? ' (logo only)' : !d.logo ? ' (pattern only)' : ''}</div>
          </div>`).join('')}
      </div>
    </div>` : `<div class="review-block"><p class="msg error">No designs yet — go back to Step 2 and add a pattern and/or a logo.</p></div>`;

  // Products grid — WITH images
  const productsHtml = `
    <div class="review-block">
      <h3>${sel.length} blank${sel.length > 1 ? 's' : ''}</h3>
      <div class="grid">
        ${sel.map(prod => {
          const info = state.wrapInfo.get(prod.id);
          const wrapKind = info?.wrap?.kind || 'single';
          const wrapBadge = wrapKind === 'single' ? '' : `<span class="badge wrap">${wrapKind}</span>`;
          return `<div class="product-card">
            <img loading="lazy" src="${prod.image || ''}" alt="">
            <div class="meta">
              <div class="title">${prod.title || 'Untitled'}</div>
              <div class="brand">#${prod.id}</div>
              ${wrapBadge}
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;

  $('#review-summary').innerHTML = `
    ${designsHtml}
    ${productsHtml}
    <div class="review-total">
      <strong>${total}</strong> template${total !== 1 ? 's' : ''} will be created
      <span class="muted">— ${sel.length} blank${sel.length > 1 ? 's' : ''} × ${pats.length} design${pats.length > 1 ? 's' : ''}</span>
      <div class="muted" style="margin-top:6px;">Saved to your Printful <strong>library</strong> (not published to any storefront). Publish later from the Templates page.</div>
    </div>`;

  // Reflect the count on the action button so it's obvious what the click does
  const startBtn = $('#start-btn');
  startBtn.textContent = total ? `Create & save ${total} template${total !== 1 ? 's' : ''} →` : 'Add a design first';
  startBtn.disabled = !total;

  // Wrap prompts for unknown wraps
  const prompts = $('#wrap-prompts');
  prompts.innerHTML = '';
  for (const prod of sel) {
    const info = state.wrapInfo.get(prod.id);
    if (info?.wrap?.kind === 'unknown-wrap') {
      const div = document.createElement('div');
      div.className = 'wrap-prompt';
      div.innerHTML = `<h4>${prod.title} has multiple panels: ${info.wrap.panels.join(', ')}</h4>
        <p class="muted">How should the pattern wrap?</p>
        <div class="opts">
          <button data-c="tile">Tile seamlessly</button>
          <button data-c="mirror">Mirror at seams</button>
          <button data-c="separate">Treat each panel separately</button>
        </div>`;
      div.querySelectorAll('button').forEach(b => {
        b.onclick = () => {
          state.wrapChoices.set(prod.id, b.dataset.c);
          div.style.borderColor = 'var(--accent)';
          div.querySelector('p').textContent = 'Choice: ' + b.dataset.c;
        };
      });
      prompts.appendChild(div);
    }
  }
}

// ---------- RUN ----------
$('#start-btn').onclick = async () => {
  const sel = Array.from(state.selected.values());
  // A design is valid with a pattern, a logo, or both.
  const designs = state.designs.filter(d => d.pattern?.fileId || d.logo?.fileId);
  if (!sel.length) return alert('Select at least one product');
  if (!designs.length) return alert('Add at least one design — a pattern, a logo, or both');

  $$('.steps button').forEach(x => x.classList.remove('active'));
  $$('.step').forEach(x => x.classList.remove('active'));
  $$('.steps button')[3].classList.add('active');
  $('#step-run').classList.add('active');

  const total = sel.length * designs.length;
  $('#results').innerHTML = '';
  $('#progress').innerHTML = `<div class="run-head"><span class="spinner"></span> Creating ${total} template${total !== 1 ? 's' : ''}…</div><div class="progress-bar"><div style="width:0%"></div></div>`;

  const job = await api('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({
      products: sel.map(p => ({ id: p.id, title: p.title })),
      patterns: designs.map(d => ({
        label: d.label || d.pattern?.name || d.logo?.name || 'Design',
        fileId: d.pattern?.fileId || null,
        url: d.pattern?.url || null,
        logo: d.logo ? { fileId: d.logo.fileId, url: d.logo.url, label: d.logo.name } : null,
      })),
      wrapChoices: Object.fromEntries(state.wrapChoices),
    }),
  });

  pollJob(job.id, total, Date.now());
};

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function pollJob(id, total, startedAt) {
  let running = true;
  // Live clock — ticks every second so the user always sees time moving,
  // independent of the 2.5s status poll.
  const tick = setInterval(() => {
    if (!running) return;
    const el = $('#run-elapsed');
    if (el) el.textContent = fmtElapsed(Date.now() - startedAt);
  }, 1000);

  try {
    while (true) {
      const j = await api(`/api/jobs/${id}`);
      const log = j.log || [];
      let done = 0, fail = 0, current = '';
      for (const ev of log) {
        if (ev.type === 'item-ok') done++;
        else if (ev.type === 'item-fail') fail++;
        else if (ev.type === 'item-start') current = ev.label;
      }
      const finished = done + fail;
      const pct = total ? Math.round((finished / total) * 100) : 0;
      const elapsed = Date.now() - startedAt;
      const eta = finished ? (elapsed / finished) * (total - finished) : 0;

      $('#progress').innerHTML = `
        <div class="run-head">
          <span class="spinner"></span>
          <strong>${finished} / ${total}</strong> done
          <span class="muted">· ${done} ok · ${fail} fail</span>
          <span class="run-timer">⏱ <span id="run-elapsed">${fmtElapsed(elapsed)}</span>${eta ? ` · ~${fmtElapsed(eta)} left` : ''}</span>
        </div>
        <div class="progress-bar"><div style="width:${pct}%"></div></div>
        <div class="run-current muted">${current ? 'Working on: ' + current : 'Starting…'}</div>
        <div class="run-log">${log.slice(-8).map(ev => {
          const cls = ev.type === 'item-ok' ? 'ok' : ev.type === 'item-fail' ? 'fail' : '';
          return `<div class="log-line ${cls}">${ev.type}${ev.label ? ' · ' + ev.label : ''}${ev.sync_id ? ' → #' + ev.sync_id : ''}</div>`;
        }).join('')}</div>`;

      if (j.status === 'done' || j.status === 'error') {
        running = false;
        clearInterval(tick);
        const okItems = j.items.filter(i => i.ok);
        const failItems = j.items.filter(i => !i.ok);
        $('#progress').innerHTML = `
          <div class="run-head ${failItems.length ? '' : 'done'}">
            ✓ Finished in ${fmtElapsed(Date.now() - startedAt)} — <strong>${okItems.length}/${j.items.length}</strong> saved${failItems.length ? ` · <span class="fail">${failItems.length} failed</span>` : ''}
          </div>
          <div class="progress-bar"><div style="width:100%"></div></div>`;
        $('#results').innerHTML = `
          <p class="muted" style="margin:4px 0 16px;">Created in your <strong>JBNY Custom Shop</strong> (visible in Printful). Open one below to edit, or manage them on the <a href="templates.html" style="color:var(--accent);">Templates page</a>.</p>
          ${failItems.length ? `<div class="review-block"><h3 class="fail">${failItems.length} failed</h3>${failItems.map(i => `<div class="log-line fail">${i.label} — ${typeof i.error === 'string' ? i.error : JSON.stringify(i.error).slice(0, 160)}</div>`).join('')}</div>` : ''}
          <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))">
            ${okItems.map(i => `
              <div class="product-card">
                <img loading="lazy" src="${i.thumbnail || ''}" alt="">
                <div class="meta">
                  <div class="title">${i.product_title || 'Product'}</div>
                  <div class="brand">${i.label}</div>
                  <a target="_blank" href="https://www.printful.com/dashboard/sync/update?id=${i.sync_id}" class="badge">#${i.sync_id} →</a>
                  ${i.placements ? `<span class="badge" title="${i.placements.join(', ')}">${i.placements.length} panel${i.placements.length > 1 ? 's' : ''}</span>` : ''}
                  ${i.wrap && i.wrap !== 'single' ? ` <span class="badge wrap">${i.wrap}</span>` : ''}
                </div>
              </div>`).join('')}
          </div>`;
        break;
      }
      await new Promise(r => setTimeout(r, 2500));
    }
  } finally {
    running = false;
    clearInterval(tick);
  }
}
