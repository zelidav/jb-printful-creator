const BACKEND = 'https://jb-printful-creator-915738985818.us-east1.run.app';
const state = {
  pass: localStorage.getItem('jb-pass') || '',
  templates: [],
  stores: [],
  sourceStore: null,
};

const $ = s => document.querySelector(s);

async function api(path, opts = {}) {
  const res = await fetch(BACKEND + path, {
    ...opts,
    headers: {
      'X-JB-Pass': state.pass,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(json.error || `${res.status}: ${text.slice(0, 200)}`);
  return json;
}

$('#password').value = state.pass;

async function doLogin() {
  state.pass = $('#password').value;
  if (!state.pass) return;
  $('#login-msg').textContent = 'Loading...';
  $('#login-msg').className = 'msg';
  try {
    const [tpls, stores] = await Promise.all([api('/api/templates'), api('/api/stores')]);
    localStorage.setItem('jb-pass', state.pass);
    state.templates = tpls.items;
    state.stores = stores.items;
    state.sourceStore = stores.source;
    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#auth-status').textContent = `${state.templates.length} templates`;
    render();
  } catch (e) {
    $('#login-msg').textContent = e.message;
    $('#login-msg').className = 'msg error';
  }
}
$('#login-btn').onclick = doLogin;
$('#password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
if (state.pass) doLogin();

function storeOptions() {
  return state.stores
    .map(s => `<option value="${s.id}">${s.name}${String(s.id) === String(state.sourceStore) ? ' (this store)' : ` · ${s.type}`}</option>`)
    .join('');
}

function render() {
  const grid = $('#grid');
  grid.innerHTML = '';
  if (!state.templates.length) {
    grid.innerHTML = '<p class="muted">No templates yet. Create some in the <a href="create.html" style="color:var(--accent);">creator</a>.</p>';
    return;
  }
  for (const t of state.templates) {
    const card = document.createElement('div');
    card.className = 'tpl-card';
    card.innerHTML = `
      <img loading="lazy" src="${t.thumbnail || ''}" alt="">
      <div class="meta">
        <div class="name">${t.name}</div>
        <div class="sub">${t.variant_count} variant${t.variant_count !== 1 ? 's' : ''} · #${t.id}</div>
        <div class="actions">
          <select data-id="${t.id}" class="target-store">${storeOptions()}</select>
          <button class="primary publish-btn" data-id="${t.id}">Publish</button>
          <button class="danger delete-btn" data-id="${t.id}">Delete</button>
        </div>
        <div class="status" id="status-${t.id}"></div>
      </div>`;
    grid.appendChild(card);
  }

  grid.querySelectorAll('.publish-btn').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const target = grid.querySelector(`select[data-id="${id}"]`).value;
      const status = $(`#status-${id}`);
      status.textContent = 'Publishing...';
      status.className = 'status';
      btn.disabled = true;
      try {
        const r = await api(`/api/templates/${id}/publish`, { method: 'POST', body: JSON.stringify({ target_store_id: target }) });
        if (r.status === 'unhidden') {
          status.textContent = `✓ Published in this store`;
          status.className = 'status ok';
        } else if (r.status === 'cloned') {
          status.textContent = `✓ Cloned to target → #${r.new_id}`;
          status.className = 'status ok';
        }
      } catch (e) {
        status.textContent = 'Publish failed: ' + e.message;
        status.className = 'status err';
        btn.disabled = false;
      }
    };
  });

  grid.querySelectorAll('.delete-btn').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('Delete this template? This cannot be undone.')) return;
      const id = btn.dataset.id;
      const status = $(`#status-${id}`);
      status.textContent = 'Deleting...';
      try {
        await api(`/api/templates/${id}`, { method: 'DELETE' });
        // remove from state + re-render
        state.templates = state.templates.filter(t => String(t.id) !== String(id));
        $('#auth-status').textContent = `${state.templates.length} templates`;
        render();
      } catch (e) {
        status.textContent = 'Delete failed: ' + e.message;
        status.className = 'status err';
      }
    };
  });
}
