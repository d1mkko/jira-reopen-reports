import Resolver from '@forge/resolver';

const resolver = new Resolver();

resolver.define('generateReport', async ({ payload }) => {
  const month = payload?.month || '(none)';
  return { message: `Backend OK. Month=${month}` };
});

export const handler = resolver.getDefinitions();
