// public/app.js
// Reopen Reports UI front-end
// - Date-range picker (single calendar, clickable days)
// - OAuth/PAT auth status
// - Preview (GET /api/preview?from&to&teams=...)
// - Generate & download (POST /api/run)
// - Team filter (by Issue key prefix)

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* -------------------- DOM -------------------- */
const rangeDisplay = $('#rangeDisplay');
const rangeText    = $('#rangeText');
const popover      = $('#rangePopover');
const monthLabel   = $('#monthLabel');
const prevBtn      = $('#prevMonth');
const nextBtn      = $('#nextMonth');
const calGrid      = $('#calGrid');
const legendText   = $('#legendText');
const applyRange   = $('#applyRange');
const cancelRange  = $('#cancelRange');

const teamBtn      = $('#teamBtn');
const teamMenu     = $('#teamMenu');
const teamList     = $('#teamList');
const teamSearch   = $('#teamSearch');
const teamApply    = $('#teamApply');
const teamClear    = $('#teamClear');

const runBtn       = $('#run');
const statusEl     = $('#status');
const previewSec   = $('#preview-section');
const bodyEl       = $('#preview-body');

const loginBtn     = $('#login');
const logoutBtn    = $('#logout');
const modeChip     = $('#mode-chip');
const loginPH      = $('#login-placeholder');

/* -------------------- State -------------------- */
let viewYear, viewMonth;                 // current calendar view
let selStart = null, selEnd = null;      // committed selection (Date)
let tempStart = null, tempEnd = null;    // temp selection while popover open
let authed = false;

let allTeams = [];                       // list of team keys available
let selectedTeams = new Set();           // chosen teams

/* -------------------- Helpers -------------------- */
const pad2   = (n) => String(n).padStart(2, '0');
const fmtISO = (d) => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
const parseISO = (s) => { const [Y,M,D] = s.split('-').map(Number); return new Date(Y, M-1, D); };

const isSameDay = (a,b) =>
  a && b &&
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

const inRange = (d, a, b) => a && b && d >= a && d <= b;

/* -------------------- Calendar -------------------- */
function setInitialRangeToCurrentMonth() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last  = new Date(now.getFullYear(), now.getMonth()+1, 0);
  selStart = first;
  selEnd   = last;
  viewYear = selStart.getFullYear();
  viewMonth = selStart.getMonth();
  updateRangeLabel();
}

function updateRangeLabel() {
  if (selStart && selEnd) {
    rangeText.textContent = `${fmtISO(selStart)} → ${fmtISO(selEnd)}`;
  } else {
    rangeText.textContent = '—';
  }
}

function openPopover() {
  // snapshot current selection to temp
  tempStart = selStart ? new Date(selStart) : null;
  tempEnd   = selEnd   ? new Date(selEnd)   : null;

  renderCalendar(); // ensure days are rendered before any click
  popover.classList.remove('hidden');
  rangeDisplay.setAttribute('aria-expanded', 'true');
}

function closePopover() {
  popover.classList.add('hidden');
  rangeDisplay.setAttribute('aria-expanded', 'false');
}

function renderCalendar() {
  const ym = new Date(viewYear, viewMonth, 1);
  monthLabel.textContent = ym.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });

  // Clear grid
  calGrid.innerHTML = '';

  // Leading blanks (Mon..Sun; make Monday=1)
  let firstDOW = new Date(viewYear, viewMonth, 1).getDay(); // 0..6 (Sun..Sat)
  if (firstDOW === 0) firstDOW = 7; // Sunday -> 7
  for (let i = 1; i < firstDOW; i++) {
    const blank = document.createElement('div');
    blank.className = 'day out';
    blank.setAttribute('aria-hidden', 'true');
    calGrid.appendChild(blank);
  }

  // Days
  const days = new Date(viewYear, viewMonth + 1, 0).getDate();
  const frag = document.createDocumentFragment();

  for (let day = 1; day <= days; day++) {
    const dateObj = new Date(viewYear, viewMonth, day);
    const div = document.createElement('div');
    div.className = 'day';
    div.dataset.iso = fmtISO(dateObj);
    div.textContent = String(day);
    div.setAttribute('role', 'button');
    div.setAttribute('tabindex', '0');

    if (tempStart && isSameDay(dateObj, tempStart)) div.classList.add('sel');
    if (tempEnd   && isSameDay(dateObj, tempEnd))   div.classList.add('sel');
    if (tempStart && tempEnd && inRange(dateObj, tempStart, tempEnd) &&
        !isSameDay(dateObj, tempStart) && !isSameDay(dateObj, tempEnd)) {
      div.classList.add('in-range');
    }

    frag.appendChild(div);
  }

  calGrid.appendChild(frag);

  legendText.textContent = tempStart && tempEnd
    ? `Range: ${fmtISO(tempStart)} → ${fmtISO(tempEnd)}`
    : (tempStart ? 'Pick an end date' : 'Click a start date');
}

/* Robust click delegation for calendar days */
calGrid.addEventListener('click', (e) => {
  const dayEl = e.target.closest('.day');
  if (!dayEl || dayEl.classList.contains('out')) return;

  const d = parseISO(dayEl.dataset.iso);
  if (!tempStart || (tempStart && tempEnd)) {
    // starting a new selection
    tempStart = d;
    tempEnd = null;
  } else {
    // finishing the selection
    if (d < tempStart) {
      tempEnd = tempStart;
      tempStart = d;
    } else {
      tempEnd = d;
    }
  }
  renderCalendar();
});

// Keyboard support for day activation
calGrid.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const dayEl = e.target.closest('.day');
  if (!dayEl || dayEl.classList.contains('out')) return;
  dayEl.click();
});

// Prevent outside-click handler from closing popover on internal clicks
popover.addEventListener('click', (e) => e.stopPropagation());
rangeDisplay.addEventListener('click', (e) => {
  e.stopPropagation();
  if (popover.classList.contains('hidden')) openPopover();
  else closePopover();
});
prevBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  viewMonth--;
  if (viewMonth < 0) { viewMonth = 11; viewYear--; }
  renderCalendar();
});
nextBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  viewMonth++;
  if (viewMonth > 11) { viewMonth = 0; viewYear++; }
  renderCalendar();
});
cancelRange.addEventListener('click', (e) => {
  e.stopPropagation();
  closePopover();
});
applyRange.addEventListener('click', (e) => {
  e.stopPropagation();
  if (tempStart && tempEnd) { selStart = tempStart; selEnd = tempEnd; }
  // If user clicked only one day, set end = start (one-day range)
  if (tempStart && !tempEnd) { selStart = tempStart; selEnd = tempStart; }
  updateRangeLabel();
  closePopover();
  if (authed) fetchPreview();
});

// Close popovers if clicking outside
document.addEventListener('click', (e) => {
  if (!rangeDisplay.contains(e.target) && !popover.contains(e.target)) closePopover();
  if (!teamBtn.contains(e.target) && !teamMenu.contains(e.target)) teamMenu.classList.add('hidden');
});

/* -------------------- Team Filter -------------------- */
function extractTeams(rows) {
  const set = new Set();
  for (const r of rows || []) {
    const key = (r['Issue key'] || '').toString();
    const proj = key.split('-')[0]?.trim();
    if (proj) set.add(proj);
  }
  return Array.from(set).sort();
}

function updateTeamButtonLabel() {
  if (!selectedTeams.size) { teamBtn.textContent = 'Teams: All'; return; }
  const arr = [...selectedTeams];
  teamBtn.textContent = arr.length === 1 ? `Team: ${arr[0]}` : `${arr[0]} +${arr.length-1}`;
}

function renderTeamMenu() {
  const q = (teamSearch.value || '').toLowerCase();
  teamList.innerHTML = '';
  const filtered = allTeams.filter(t => t.toLowerCase().includes(q));
  if (!filtered.length) {
    teamList.innerHTML = `<div class="menu-item" style="color:#6b7280">No teams</div>`;
    return;
  }
  filtered.forEach(team => {
    const row = document.createElement('label');
    row.className = 'menu-item';
    row.innerHTML = `
      <input type="checkbox" ${selectedTeams.has(team) ? 'checked' : ''}/>
      <span>${team}</span>
    `;
    row.addEventListener('click', (e) => {
      if (e.target.tagName !== 'INPUT') {
        const cb = row.querySelector('input');
        cb.checked = !cb.checked;
      }
      const checked = row.querySelector('input').checked;
      if (checked) selectedTeams.add(team); else selectedTeams.delete(team);
    });
    teamList.appendChild(row);
  });
}

teamBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (teamMenu.classList.contains('hidden')) {
    renderTeamMenu();
    teamMenu.classList.remove('hidden');
  } else {
    teamMenu.classList.add('hidden');
  }
});

teamApply.addEventListener('click', (e) => {
  e.stopPropagation();
  teamMenu.classList.add('hidden');
  updateTeamButtonLabel();
  if (authed) fetchPreview();
});

teamClear.addEventListener('click', (e) => {
  e.stopPropagation();
  selectedTeams.clear();
  teamSearch.value = '';
  renderTeamMenu();
  updateTeamButtonLabel();
  if (authed) fetchPreview();
});

teamSearch.addEventListener('input', renderTeamMenu);

/* -------------------- Networking -------------------- */
async function getAuthStatus() {
  const r = await fetch('/auth/status', { cache: 'no-store' });
  const js = await r.json();
  authed = !!js.signedIn || !!js.hasPATFallback;

  // Toggle UI on auth
  modeChip.style.display   = js.signedIn ? '' : 'none';
  loginPH.style.display    = authed ? 'none' : '';
  previewSec.style.display = authed ? '' : 'none';
  loginBtn.style.display   = js.signedIn ? 'none' : '';
  logoutBtn.style.display  = js.signedIn ? '' : '';
}

function paramsForPreview() {
  const p = new URLSearchParams();
  p.set('from', fmtISO(selStart));
  p.set('to',   fmtISO(selEnd));
  if (selectedTeams.size) p.set('teams', [...selectedTeams].join(','));
  return p.toString();
}

async function fetchPreview() {
  statusEl.textContent = 'Loading preview…';
  const r = await fetch(`/api/preview?${paramsForPreview()}`);
  const txt = await r.text();
  let js;
  try { js = JSON.parse(txt); } catch { js = { ok:false, error: txt }; }

  if (!r.ok || !js.ok) {
    statusEl.textContent = `Server error ${r.status}\n${js.error || txt}`;
    return;
  }

  // Teams from server if provided; else derive from rows
  allTeams = js.teams && js.teams.length ? js.teams : extractTeams(js.rows || []);
  renderTeamMenu();
  updateTeamButtonLabel();

  renderRows(js.rows || []);
  statusEl.textContent = `Preview: ${(js.rows || []).length} issues (${fmtISO(selStart)} → ${fmtISO(selEnd)}).`;
}

function renderRows(rows) {
  bodyEl.innerHTML = '';
  if (!rows.length) {
    bodyEl.innerHTML = `<tr><td colspan="7" class="empty">No data in range.</td></tr>`;
    return;
  }

  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const logLines = (r['Reopen Log'] || '')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="issue-key">${r['Issue key'] || ''}</td>
      <td class="issue-type">${r['Issue Type'] || ''}</td>
      <td class="issue-id">${r['Issue id'] || ''}</td>
      <td class="summary">${r['Summary'] || ''}</td>
      <td class="assignee">${r['Assignee'] || ''}</td>
      <td class="reopen-count">${r['Reopen Count'] ?? ''}</td>
      <td class="reopen-log">${logLines.map(l => `<div>${l}</div>`).join('')}</td>
    `;
    frag.appendChild(tr);
  }
  bodyEl.appendChild(frag);
}

/* -------------------- Auth & Run -------------------- */
loginBtn.addEventListener('click', () => { window.location.href = '/auth/login'; });
logoutBtn.addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST' });
  await getAuthStatus();
});

runBtn.addEventListener('click', async () => {
  if (!authed) return alert('Please sign in first.');
  statusEl.textContent = 'Generating reports…';
  const payload = {
    from: fmtISO(selStart),
    to:   fmtISO(selEnd),
    teams: [...selectedTeams],
  };
  const r = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const txt = await r.text();
    statusEl.textContent = `Server error ${r.status}\n${txt}`;
    return;
  }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `reopen_reports_${payload.from}_to_${payload.to}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  statusEl.textContent = 'Done. ZIP with two reports downloaded ✅';
});

/* -------------------- Init -------------------- */
(async function init() {
  setInitialRangeToCurrentMonth();
  await getAuthStatus();
  if (authed) await fetchPreview();
})();
