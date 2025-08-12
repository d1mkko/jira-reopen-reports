import { invoke } from '@forge/bridge';

document.addEventListener('DOMContentLoaded', () => {
  console.log('[UI] DOM ready, main.js running');

  const monthEl = document.getElementById('month');
  const btn = document.getElementById('run');
  const out = document.getElementById('output');

  if (!monthEl || !btn || !out) {
    console.error('[UI] Missing required elements', { monthEl, btn, out });
    return;
  }

  if (!monthEl.value) monthEl.value = new Date().toISOString().slice(0, 7);
  console.log('[UI] Initial month value:', monthEl.value);

  btn.addEventListener('click', async () => {
    console.log('[UI] Clicked Generate report, month=', monthEl.value);
    out.textContent = 'Calling backend…';
    try {
      const res = await invoke('countReopens', { month: monthEl.value });
      console.log('[UI] invoke success:', res);
      out.textContent = JSON.stringify(res, null, 2);
    } catch (e) {
      console.error('[UI] invoke failed', e);
      out.textContent = 'Error: ' + (e?.message || e);
    }
  });
});

