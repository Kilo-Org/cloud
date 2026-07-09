import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repositoryRoot = resolve(process.cwd(), '../..');
const sourceRoots = ['apps', 'dev', 'packages', 'services'];

const classifiedIncrementWriters = {
  'apps/web/src/lib/ai-gateway/processUsage.ts': 'included_ai_gateway_personal',
  'apps/web/src/lib/coding-plans/billing-lifecycle-cron.ts': 'included_coding_plan_renewal',
  'apps/web/src/lib/coding-plans/index.ts': 'included_coding_plan_activation',
  'apps/web/src/lib/exa-usage.ts': 'included_exa_personal',
  'apps/web/src/lib/kiloclaw/credit-billing.ts': 'included_kiloclaw_enrollment',
  'apps/web/src/lib/organizations/organization-usage.ts':
    'included_ai_gateway_and_exa_organization',
  'services/kiloclaw-billing/src/lifecycle.ts': 'included_kiloclaw_renewal',
  'apps/web/src/app/admin/api/organizations/[id]/consume-credits/route.ts':
    'excluded_development_consume_route',
  'apps/web/src/routers/admin-router.ts': 'excluded_development_balance_jitter',
  'dev/seed/kiloclaw/fake-instance.ts': 'excluded_development_seed',
} as const;

const rawSqlIncrement = /\bSET\s+microdollars_used\s*=\s*microdollars_used\s*\+/;
const drizzleIncrement = /\bmicrodollars_used\s*:\s*sql`[^`]*\bmicrodollars_used\b[^`]*\+/;

function listTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(path));
    } else if (
      entry.isFile() &&
      path.endsWith('.ts') &&
      !path.endsWith('.test.ts') &&
      !path.endsWith('.spec.ts')
    ) {
      files.push(path);
    }
  }
  return files;
}

describe('Cost Insights Credit-spend writer audit', () => {
  test('requires every direct microdollars_used increment to have an explicit classification', () => {
    const detectedWriters = sourceRoots
      .flatMap(sourceRoot => listTypeScriptFiles(join(repositoryRoot, sourceRoot)))
      .filter(path => {
        const source = readFileSync(path, 'utf8');
        return rawSqlIncrement.test(source) || drizzleIncrement.test(source);
      })
      .map(path => relative(repositoryRoot, path))
      .sort();

    expect(detectedWriters).toEqual(Object.keys(classifiedIncrementWriters).sort());
  });
});
