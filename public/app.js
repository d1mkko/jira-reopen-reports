const monthEl = document.getElementById('month');
const runBtn = document.getElementById('run');
const logEl = document.getElementById('log');
const btnText = runBtn.querySelector('.btn-text');
const btnSpin = runBtn.querySelector('.btn-spin');

const loginBtn = document.getElementById('login');
const logoutBtn = document.getElementById('logout');
const authStatus = document.getElementById('auth-status');

if (!monthEl.value) monthEl.value = new Date().toISOString().slice(0,7);

const setBusy = (busy) => {
  runBtn.disabled = busy;
  btnText.style.display = busy ? 'none' : '';
  btnSpin.style.display = busy ? 'inline-flex' : 'none';
};

const log = (msg, cls='') => {
  const div = document.createElement('div');
  div.textContent = msg;
  if (cls) div.className = cls;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
};
const clear = () => (logEl.textContent = '');

async function getAuthStatus() {
  const r = await fetch('/auth/status', { cache: 'no-store' });
  return r.json();
}

async function refreshAuthStatus() {
  authStatus.textContent = 'Checking auth…';
  try {
    const js = await getAuthStatus();
    if (js.signedIn) {
      const name = js.account?.name || 'Atlassian';
      authStatus.textContent = `Signed in: ${name}`;
      loginBtn.style.display = 'none';
      logoutBtn.style.display = '';
    } else {
      authStatus.textContent = js.hasPATFallback
        ? 'Not signed in (using server token fallback)'
        : 'Not signed in (no token fallback configured)';
      loginBtn.style.display = '';
      logoutBtn.style.display = 'none';
    }
  } catch {
    authStatus.textContent = 'Auth status error';
  }
}

loginBtn.addEventListener('click', () => {
  // just go to OAuth login; no auto-run flags
  location.href = '/auth/login';
});

logoutBtn.addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST' });
  await refreshAuthStatus();
});

runBtn.addEventListener('click', async () => {
  clear();
  const month = monthEl.value;
  if (!/^\d{4}-\d{2}$/.test(month)) { log('Pick a month (YYYY-MM)', 'err'); return; }

  setBusy(true);
  log(`Generating reports for ${month}…`);
  try {
    const resp = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ month })
    });
    if (!resp.ok) {
      const text = await resp.text();
      log(`Server error ${resp.status}`, 'err');
      log(text, 'err');
      return;
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reopen_reports_${month}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    log('Done. ZIP with two reports downloaded ✅', 'ok');
  } catch (e) {
    console.error(e);
    log(e.message || String(e), 'err');
  } finally {
    setBusy(false);
  }
});

// On load: update auth UI and clean ?auth=ok if present
(async function init() {
  await refreshAuthStatus();
  const url = new URL(location.href);
  if (url.searchParams.get('auth') === 'ok') {
    url.searchParams.delete('auth');
    history.replaceState({}, '', url.toString());
  }
})();
