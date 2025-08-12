import { invoke } from '@forge/bridge';

const monthEl = document.getElementById('month');
const btn = document.getElementById('run');
const out = document.getElementById('output');

// show we loaded the latest bundle
console.log('BUILD STAMP', new Date().toISOString());

if (!monthEl.value) monthEl.value = new Date().toISOString().slice(0, 7);

btn.addEventListener('click', async () => {
  out.textContent = 'Calling backend…';
  try {
    const res = await invoke('ping', { month: monthEl.value });
    out.textContent = JSON.stringify(res, null, 2);
  } catch (e) {
    console.error('invoke failed', e);
    out.textContent = 'invoke failed: ' + (e?.message || e);
  }
});

