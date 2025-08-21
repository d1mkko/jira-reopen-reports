const monthEl = document.getElementById('month');
const runBtn = document.getElementById('run');
const logEl = document.getElementById('log');

if (!monthEl.value) monthEl.value = new Date().toISOString().slice(0,7);

const log = (msg, cls='') => {
  const div = document.createElement('div');
  div.textContent = msg;
  if (cls) div.className = cls;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
};
const clear = () => logEl.textContent = '';

runBtn.addEventListener('click', async () => {
  clear();
  const month = monthEl.value;
  if (!/^\d{4}-\d{2}$/.test(month)) { log('Pick a month (YYYY-MM)', 'err'); return; }
  log(`Generating reports for ${month}…`);
  runBtn.disabled = true;
  try {
    const resp = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ month })
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Server error: ${resp.status}\n${text}`);
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
    log('Download started ✅', 'ok');
  } catch (e) {
    console.error(e);
    log(e.message || String(e), 'err');
  } finally {
    runBtn.disabled = false;
  }
});
