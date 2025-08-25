// public/app.js

const monthEl       = document.getElementById('month');
const runBtn        = document.getElementById('run');
const statusEl      = document.getElementById('status');
const loginBtn      = document.getElementById('login');
const logoutBtn     = document.getElementById('logout');
const modeChip      = document.getElementById('mode-chip');
const previewTBody  = document.getElementById('preview-body');
const previewSection= document.getElementById('preview-section');
const loginPlaceholder = document.getElementById('login-placeholder');

let canViewData = false;

function currentMonthISO() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const cur = new Date(Date.UTC(y, m, 1));
  return cur.toISOString().slice(0,7);
}
function uiSetStatus(text) { statusEl.textContent = text || ''; }

async function fetchJSON(url, opts) {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type':'application/json', ...(opts?.headers||{}) }});
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { ok:r.ok, status:r.status, data, raw:text };
}

async function loadAuthStatus() {
  const res = await fetchJSON('/auth/status');
  const signedIn = !!res.data?.signedIn;
  const hasPAT   = !!res.data?.hasPATFallback;
  const mode     = res.data?.mode || (signedIn ? 'oauth' : (hasPAT ? 'pat' : 'none'));

  canViewData = signedIn || hasPAT;

  loginBtn.style.display  = signedIn ? 'none' : '';
  logoutBtn.style.display = signedIn ? '' : 'none';

  if (mode !== 'none') {
    modeChip.style.display = '';
    modeChip.textContent   = mode === 'oauth' ? 'Using OAuth' : 'Using PAT fallback';
  } else {
    modeChip.style.display = 'none';
  }

  if (canViewData) {
    previewSection.style.display = '';
    loginPlaceholder.style.display = 'none';
  } else {
    previewSection.style.display = 'none';
    loginPlaceholder.style.display = '';
    uiSetStatus('');
  }
}

function renderPreviewRows(rows) {
  previewTBody.innerHTML = '';
  if (!rows || rows.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'empty';
    td.textContent = 'No data for this month.';
    tr.appendChild(td);
    previewTBody.appendChild(tr);
    return;
  }

  const safe = v => (v === null || v === undefined) ? '' : String(v);

  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${safe(r['Issue key'])}</td>
      <td>${safe(r['Issue Type'])}</td>
      <td>${safe(r['Issue id'])}</td>
      <td>${safe(r['Summary'])}</td>
      <td>${safe(r['Assignee'])}</td>
      <td>${safe(r['Reopen Count'])}</td>
      <td>
  ${
    safe(r['Reopen Log'])
      .split(/(?=\d{4}-\d{2}-\d{2})/)   // split before each date (YYYY-MM-DD)
      .map(line => `<div>${line.trim()}</div>`)
      .join('')
  }
</td>

    `;
    previewTBody.appendChild(tr);
  }
}

async function loadPreview(month) {
  if (!canViewData) return;

  previewTBody.innerHTML = '';
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = 7;
  td.className = 'empty';
  td.textContent = `Loading data for ${month}…`;
  tr.appendChild(td);
  previewTBody.appendChild(tr);

  try {
    const q = new URLSearchParams({ month }).toString();
    const r = await fetch(`/api/preview?${q}`);
    const txt = await r.text();
    let data; try { data = JSON.parse(txt); } catch { data = { ok:false, error:'Invalid JSON' }; }

    if (r.status === 401) {
      renderPreviewRows([]);
      uiSetStatus('🔒 Please log in with Atlassian to view Jira data.');
      return;
    }

    if (!r.ok || !data.ok) {
      renderPreviewRows([]);
      uiSetStatus(`Preview error ${r.status}: ${data.error || txt}`);
      return;
    }

    renderPreviewRows(data.rows);
  } catch (e) {
    renderPreviewRows([]);
    uiSetStatus(`Preview error: ${e?.message || e}`);
  }
}

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

    if (r.status === 401) {
      uiSetStatus('🔒 Please log in with Atlassian before generating reports.');
      return;
    }

    if (!r.ok) {
      const err = await r.text();
      uiSetStatus(`Server error ${r.status}\n${err}`);
      return;
    }

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

(async function init(){
  if (!monthEl.value) monthEl.value = currentMonthISO();
  await loadAuthStatus();
  await loadPreview(monthEl.value);

  monthEl.addEventListener('change', async () => {
    if (/^\d{4}-\d{2}$/.test(monthEl.value)) {
      await loadAuthStatus();
      await loadPreview(monthEl.value);
    }
  });

  try {
    const url = new URL(location.href);
    if (url.searchParams.get('auth') === 'ok') {
      url.searchParams.delete('auth');
      history.replaceState({}, '', url.toString());
      await loadAuthStatus();
      await loadPreview(monthEl.value);
    }
  } catch {}
})();
