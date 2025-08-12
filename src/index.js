import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';

const resolver = new Resolver();

// "YYYY-MM" -> { start:"YYYY-MM-01", end:"YYYY-MM-<last>" }
function monthToRange(month) {
  const m = String(month || '').trim();
  if (!/^\d{4}-\d{2}$/.test(m)) {
    throw new Error('Bad month format. Use YYYY-MM (e.g., 2025-08)');
  }
  const [year, mStr] = m.split('-');
  const y = Number(year);
  const mm = Number(mStr);
  const start = new Date(y, mm - 1, 1);
  const end = new Date(y, mm, 0);
  const fmt = d => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

resolver.define('countReopens', async ({ payload }) => {
  const month = payload?.month;
  const { start, end } = monthToRange(month);

  const jql =
    `status CHANGED TO "Reopen" DURING ("${start}", "${end}") ` +
    `AND "Reopen log [Short text]" IS NOT EMPTY`;

  // We only need the total, so ask for 0 results.
  const body = {
    jql,
    maxResults: 0,
    fields: ['id']
  };

  const resp = await api.asApp().requestJira(route`/rest/api/3/search`, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const text = await resp.text();
    return {
      ok: false,
      error: `Jira search failed: ${resp.status}`,
      details: text,
      month,
      start,
      end,
      jql
    };
  }

  const data = await resp.json();
  return {
    ok: true,
    month,
    start,
    end,
    jql,
    totalMatches: data.total ?? 0
  };
});

export const handler = resolver.getDefinitions();

