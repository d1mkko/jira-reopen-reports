// public/app.js

const monthEl   = document.getElementById('month');
const runBtn    = document.getElementById('run');
const statusEl  = document.getElementById('status');
const loginBtn  = document.getElementById('login');
const logoutBtn = document.getElementById('logout');
const modeChip  = document.getElementById('mode-chip');

// ===== Utils =====
function prevMonthISO() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0..11
  const prev = new Date(Date.UTC(y, m - 1, 1));
  return prev.toISOString().slice(0,7);
}
function uiSetStatus(text) { statusEl.textContent = text || ''; }

async function fetchJSON(url, opts) {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type':'application/json', ...(opts?.headers||{}) }});
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { ok:r.ok, status:r.status, data, raw:text };
}

// ===== Auth status banner =====
async function loadAuthStatus() {
  const res = await fetchJSON('/auth/status');
  const signedIn = !!res.data?.signedIn;
  const mode = res.data?.mode || (signedIn ? 'oauth' : (res.data?.hasPATFallback ? 'pat' : 'none'));

  loginBtn.style.display  = signedIn ? 'none' : '';
  logoutBtn.style.display = signedIn ? '' : 'none';

  if (mode !== 'none') {
    modeChip.style.display = '';
    modeChip.textContent = mode === 'oauth' ? 'Using OAuth' : 'Using PAT fallback';
  } else {
    modeChip.style.display = 'none';
  }
}

// ===== Actions =====
loginBtn.addEventListener('click', () => { window.location.href = '/auth/login'; });
logoutBtn.addEventListener('click', async () => {
  await fetchJSON('/auth/logout', { method:'POST' });
  await loadAuthStatus();
  uiSetStatus('Signed out.');
});

runBtn.addEventListener('click', async () => {
  const month = monthEl.value;
  if (!/^\d{4}-\d{2}$/.test(month)) {
    uiSetStatus('Pick a month (YYYY-MM)');
    return;
  }

  uiSetStatus(`Generating reports for ${month}…`);

  try {
    const r = await fetch('/api/run', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ month }),
    });

    if (!r.ok) {
      const err = await r.text();
      uiSetStatus(`Server error ${r.status}\n${err}`);
      return;
    }

    // download zip
    const blob = await r.blob();
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reopen_reports_${month}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    uiSetStatus(`Done. ZIP with two reports downloaded ✔️`);
  } catch (e) {
    uiSetStatus(`Failed: ${e?.message || e}`);
  }
});

// ===== Init =====
(function init(){
  if (!monthEl.value) monthEl.value = prevMonthISO();
  loadAuthStatus();

  // Clean ?auth=ok from URL if present
  try {
    const url = new URL(location.href);
    if (url.searchParams.get('auth') === 'ok') {
      url.searchParams.delete('auth');
      history.replaceState({}, '', url.toString());
    }
  } catch {}
})();
