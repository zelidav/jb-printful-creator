const BACKEND = 'https://jb-printful-creator-915738985818.us-east1.run.app';
const state = {
  backend: BACKEND,
  pass: localStorage.getItem('jb-pass') || '',
  catalog: [],
  selected: new Map(),  // catalog_id -> product
  patterns: [],         // [{ label, file, dataUrl, fileId, url }]
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
$$('.steps button').forEach(b => {
  b.onclick = () => {
    $$('.steps button').forEach(x => x.classList.remove('active'));
    $$('.step').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    $('#step-' + b.dataset.step).classList.add('active');
    if (b.dataset.step === 'patterns') renderPatterns();
    if (b.dataset.step === 'review') renderReview();
  };
});

// ---------- CATALOG ----------
function renderCatalog() {
  const q = $('#catalog-search').value.toLowerCase();
  const filtered = q
    ? state.catalog.filter(p => (p.title || '').toLowerCase().includes(q) || (p.brand || '').toLowerCase().includes(q))
    : state.catalog;
  $('#catalog-count').textContent = filtered.length;
  $('#selected-count').textContent = state.selected.size;
  const grid = $('#catalog-grid');
  grid.innerHTML = '';
  filtered.slice(0, 200).forEach(p => {
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
    grid.appendChild(card);
  });
}

let catalogTimer;
$('#catalog-search').oninput = () => {
  clearTimeout(catalogTimer);
  catalogTimer = setTimeout(renderCatalog, 150);
};

// ---------- PATTERNS ----------
function renderPatterns() {
  const wrap = $('#pattern-slots');
  wrap.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const p = state.patterns[i];
    const slot = document.createElement('div');
    slot.className = 'pattern-slot' + (p ? ' filled' : '');
    if (p) {
      slot.innerHTML = `
        <img src="${p.dataUrl}">
        <input type="text" value="${p.label}" placeholder="Label (e.g. Indica)">
        <button>Remove</button>`;
      slot.querySelector('input').oninput = e => { p.label = e.target.value; };
      slot.querySelector('button').onclick = () => { state.patterns.splice(i, 1); renderPatterns(); };
    } else {
      slot.innerHTML = `<div class="hint">Slot ${i + 1}</div><input type="file" accept="image/*">`;
      slot.querySelector('input').onchange = async e => {
        const file = e.target.files[0];
        if (!file) return;
        const dataUrl = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
        slot.querySelector('.hint').textContent = 'Uploading...';
        try {
          const fd = new FormData(); fd.append('file', file);
          const r = await api('/api/upload', { method: 'POST', body: fd });
          state.patterns.push({ label: file.name.replace(/\.[^.]+$/, ''), file, dataUrl, fileId: r.id, url: r.url });
          renderPatterns();
        } catch (err) { slot.querySelector('.hint').textContent = 'Upload failed: ' + err.message; }
      };
    }
    wrap.appendChild(slot);
  }
}

// ---------- REVIEW ----------
async function renderReview() {
  const sel = Array.from(state.selected.values());
  const pats = state.patterns.filter(p => p.fileId);

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
  const pats = state.patterns.filter(p => p.fileId);
  if (!sel.length || !pats.length) return alert('Select products and upload patterns first');

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
      patterns: pats.map(p => ({ label: p.label, fileId: p.fileId, url: p.url })),
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
      $('#results').innerHTML = `<h3>Done — ${okItems.length}/${j.items.length} created</h3>
        <ul>${okItems.map(i => `<li>${i.label} → <a target="_blank" href="https://www.printful.com/dashboard/sync/${i.sync_id}">#${i.sync_id}</a></li>`).join('')}</ul>`;
      break;
    }
    await new Promise(r => setTimeout(r, 2500));
  }
}
