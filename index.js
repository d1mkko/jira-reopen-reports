import Resolver from '@forge/resolver';

const resolver = new Resolver();

// simplest resolver just to confirm the round-trip
resolver.define('ping', async ({ payload }) => {
  const month = payload?.month ?? null;
  return {
    ok: true,
    message: 'Backend reached ✅',
    month,
    now: new Date().toISOString(),
  };
});

export const handler = resolver.getDefinitions();

