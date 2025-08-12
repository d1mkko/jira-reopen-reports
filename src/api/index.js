import Resolver from '@forge/resolver';

const resolver = new Resolver();

function normalizeMonth(m) {
  // expect "YYYY-MM" or undefined
  if (!m) return null;
  const [y, mm] = m.split('-');
  if (!y || !mm) return null;
  return `${y}-${mm.padStart(2, '0')}`;
}

async function echo(payload) {
  const month = normalizeMonth(payload?.month);
  console.log('echo handler called with', { month });
  return {
    ok: true,
    marker: 'ECHO-STATIC',
    month,
    now: new Date().toISOString(),
  };
}

// expose both names so UI can't miss
resolver.define('echoTest', async ({ payload }) => echo(payload));
resolver.define('generateReport', async ({ payload }) => echo(payload));

export const handler = resolver.getDefinitions();

