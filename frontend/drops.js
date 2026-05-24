const BACKEND = 'https://jb-printful-creator-915738985818.us-east1.run.app';
const state = { pass: localStorage.getItem('jb-pass') || '' };
const $ = s => document.querySelector(s);

async function api(path) {
  const res = await fetch(BACKEND + path, { headers: { 'X-JB-Pass': state.pass } });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(json.error || `${res.status}: ${text.slice(0, 200)}`);
  return json;
}

$('#password').value = state.pass;
async function doLogin() {
  state.pass = $('#password').value;
  if (!state.pass) return;
  $('#login-msg').textContent = 'Loading…';
  $('#login-msg').className = 'msg';
  try {
    const r = await api('/api/drop-patterns');
    localStorage.setItem('jb-pass', state.pass);
    $('#login').hidden = true;
    $('#app').hidden = false;
    render(r.items || []);
  } catch (e) {
    $('#login-msg').textContent = e.message;
    $('#login-msg').className = 'msg error';
  }
}
$('#login-btn').onclick = doLogin;
$('#password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
if (state.pass) doLogin();

function render(items) {
  // Group by strain → show pattern, solid, and the paired logo together.
  const byStrain = {};
  const logoByStrain = {};
  for (const it of items) {
    (byStrain[it.strain] = byStrain[it.strain] || []).push(it);
    if (it.logo) logoByStrain[it.strain] = it.logo;
  }
  const wrap = $('#drops-wrap');
  wrap.innerHTML = '';
  for (const strain of Object.keys(byStrain)) {
    const arts = byStrain[strain];
    const logo = logoByStrain[strain];
    const section = document.createElement('div');
    section.className = 'drop-section';
    section.innerHTML = `
      <h3>${strain}</h3>
      <div class="drop-tiles">
        ${arts.map(a => `
          <figure class="drop-tile">
            <img loading="lazy" src="${a.url}" alt="${a.label}">
            <figcaption>${a.kind === 'solid' ? 'Solid' : 'Pattern'}</figcaption>
          </figure>`).join('')}
        ${logo ? `
          <figure class="drop-tile logo">
            <img loading="lazy" src="${logo.url}" alt="${strain} logo">
            <figcaption>Logo</figcaption>
          </figure>` : ''}
      </div>`;
    wrap.appendChild(section);
  }
}
