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
}
$$('.steps button').forEach(b => { b.onclick = () => goToStep(b.dataset.step); });
document.addEventListener('click', e => { if (e.target?.id === 'next-fab') goToStep('patterns'); });

// ---------- CATALOG ----------
function makeProductCard(p) {
  const card = document.createElement('div');
  card.className = 'product-card' + (state.selected.has(p.id) ? ' selected' : '');
  card.innerHTML = `
    <img loading="lazy" src="${p.image || ''}" alt="">
    <div class="meta">
      <div class="title">${p.title || 'Untitled'}</div>
      <div class="brand">${p.brand || ''}</div>
      <span class="badge">#${p.id}</span>
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

  // Floating Next button (only show if selected > 0)
  $('#next-fab').hidden = state.selected.size === 0;
  $('#next-fab').textContent = `Next: Patterns & Logo (${state.selected.size}) →`;

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

// ---------- DESIGN SLOTS (pattern + logo per design) ----------
async function uploadOne(file) {
  const fd = new FormData(); fd.append('file', file);
  return api('/api/upload', { method: 'POST', body: fd });
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
  // ensure at least one empty slot trailing
  if (state.designs.length < 3) {
    const last = state.designs[state.designs.length - 1];
    if (last && (last.pattern || last.logo || last.label)) state.designs.push({ label: '', pattern: null, logo: null });
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
    cell.innerHTML = `
      <div class="label">${role}</div>
      <div class="hint">Pick a ${role} (drop or click)</div>
      <input type="file" accept="image/*" style="margin-top:8px">`;
    pickAndUpload(role, cell, (data) => {
      state.designs[idx][role] = data;
      if (!state.designs[idx].label) state.designs[idx].label = data.name;
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
  const pats = state.designs.filter(d => d.pattern?.fileId && d.logo?.fileId);

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

  let html = `<table><thead><tr><th>Product</th><th>Placements</th><th>Wrap</th></tr></thead><tbody>`;
  for (const prod of sel) {
    const info = state.wrapInfo.get(prod.id);
    const wrapKind = info?.wrap?.kind || 'single';
    const badge = wrapKind === 'single' ? '' : `<span class="badge wrap">${wrapKind}</span>`;
    html += `<tr><td>${prod.title} <span class="muted">#${prod.id}</span></td>
      <td class="muted">${(info?.placements || []).map(p => p.placement).join(', ') || '—'}</td>
      <td>${badge}</td></tr>`;
  }
  html += `</tbody></table>
    <p>Will create <strong>${sel.length * pats.length}</strong> products: ${sel.length} blanks × ${pats.length} patterns.</p>`;
  $('#review-summary').innerHTML = html;

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
  const designs = state.designs.filter(d => d.pattern?.fileId && d.logo?.fileId);
  if (!sel.length) return alert('Select at least one product');
  if (!designs.length) return alert('Add at least one design — both a pattern AND a logo per design');
  const incomplete = state.designs.filter(d => (d.pattern && !d.logo) || (!d.pattern && d.logo));
  if (incomplete.length) return alert('One or more designs has only a pattern or only a logo. Complete or remove them.');

  $$('.steps button').forEach(x => x.classList.remove('active'));
  $$('.step').forEach(x => x.classList.remove('active'));
  $$('.steps button')[3].classList.add('active');
  $('#step-run').classList.add('active');

  $('#progress').innerHTML = `<div>Starting job...</div><div class="progress-bar"><div style="width:0%"></div></div>`;
  $('#results').innerHTML = '';

  const job = await api('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({
      products: sel.map(p => ({ id: p.id, title: p.title })),
      patterns: designs.map(d => ({
        label: d.label || d.pattern.name,
        fileId: d.pattern.fileId,
        url: d.pattern.url,
        logo: { fileId: d.logo.fileId, url: d.logo.url, label: d.logo.name },
      })),
      wrapChoices: Object.fromEntries(state.wrapChoices),
    }),
  });

  const total = sel.length * pats.length;
  let done = 0;
  const es = new EventSource(state.backend + `/api/jobs/${job.id}/stream?_pass=${encodeURIComponent(state.pass)}`);
  // EventSource cannot send custom headers in browser; fallback to polling
  es.close();
  pollJob(job.id, total);
};

async function pollJob(id, total) {
  const log = [];
  while (true) {
    const j = await api(`/api/jobs/${id}`);
    const newLog = j.log.slice(log.length);
    log.push(...newLog);
    let done = 0; let fail = 0;
    for (const ev of log) { if (ev.type === 'item-ok') done++; if (ev.type === 'item-fail') fail++; }
    const pct = Math.round(((done + fail) / total) * 100);
    $('#progress').innerHTML = `
      <div>${done} ok · ${fail} fail · ${total - done - fail} pending</div>
      <div class="progress-bar"><div style="width:${pct}%"></div></div>
      <div>${log.slice(-10).map(ev => {
        const cls = ev.type === 'item-ok' ? 'ok' : ev.type === 'item-fail' ? 'fail' : '';
        return `<div class="log-line ${cls}">${ev.type}${ev.label ? ' · ' + ev.label : ''}${ev.sync_id ? ' → #' + ev.sync_id : ''}</div>`;
      }).join('')}</div>`;
    if (j.status === 'done' || j.status === 'error') {
      const okItems = j.items.filter(i => i.ok);
      $('#results').innerHTML = `<h3>Done — ${okItems.length}/${j.items.length} templates saved</h3>
        <p class="muted">Saved to your Printful library, not on any storefront. <a href="templates.html" style="color:var(--accent);">→ Go to Templates</a> to review, edit, and publish to a store when ready.</p>
        <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))">
          ${okItems.map(i => `
            <div class="product-card">
              <img loading="lazy" src="${i.thumbnail || ''}" alt="">
              <div class="meta">
                <div class="title">${i.product_title || 'Product'}</div>
                <div class="brand">${i.label}</div>
                <a target="_blank" href="https://www.printful.com/dashboard/products/${i.sync_id}" class="badge">#${i.sync_id} →</a>
                ${i.placements ? `<span class="badge" title="${i.placements.join(', ')}">${i.placements.length} panel${i.placements.length>1?'s':''}</span>` : ''}
                ${i.wrap && i.wrap !== 'single' ? ` <span class="badge wrap">${i.wrap}</span>` : ''}
              </div>
            </div>`).join('')}
        </div>`;
      break;
    }
    await new Promise(r => setTimeout(r, 2500));
  }
}
