import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { shippedPolicyDocuments } from './repo';

/**
 * The shared Bouncer client of `apps/web` and `apps/ai-gateway` installs the Bouncer scopes listed
 * in `BOUNCER_APP_SCOPES` (`packages/web-shared/src/lib/bouncer/sts-auth-contract.ts`). They must be
 * exactly the Bouncer scopes the app's policy grants in production, or the app would mint a scope
 * STS denies or never send one it holds; and no other place in the policy may grant one, because
 * Bouncer runs in production only. This package does not import web-shared, so the table is read
 * as text, through a relative path literal so the CI change detector runs this test when the
 * contract changes.
 */

const CONTRACT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/web-shared/src/lib/bouncer/sts-auth-contract.ts'
);

const APPS = [
  { caller: 'kilocode-app', workload: 'web' },
  { caller: 'kilocode-ai-gateway', workload: 'ai-gateway' },
] as const;

/** The scopes `BOUNCER_APP_SCOPES` lists for `caller`. */
function appScopes(caller: string): string[] {
  const source = readFileSync(CONTRACT, 'utf8');
  const table = /export const BOUNCER_APP_SCOPES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source)?.[1];
  if (table === undefined) throw new Error('BOUNCER_APP_SCOPES not found in sts-auth-contract.ts');
  const entry = new RegExp(`'${caller}':\\s*\\[([^\\]]*)\\]`).exec(table)?.[1];
  if (entry === undefined) throw new Error(`BOUNCER_APP_SCOPES has no ${caller} entry`);
  return [...entry.matchAll(/'([^']+)'/g)].map(match => match[1]);
}

type PolicyDocument = {
  workload?: unknown;
  scopes?: unknown;
  environmentGrants?: Record<string, { scopes?: unknown } | undefined>;
};

function policyOf(workload: string): PolicyDocument {
  const found = shippedPolicyDocuments().find(
    ({ document }) => (document as PolicyDocument).workload === workload
  );
  if (found === undefined) throw new Error(`no policy for workload ${workload}`);
  return found.document as PolicyDocument;
}

const bouncerScopes = (scopes: unknown): string[] =>
  Array.isArray(scopes)
    ? scopes.filter((scope): scope is string => String(scope).startsWith('bouncer:'))
    : [];

describe('BOUNCER_APP_SCOPES', () => {
  it.each(APPS)(
    'gives $caller exactly the production Bouncer grant of the $workload policy, which no other place widens',
    ({ caller, workload }) => {
      const policy = policyOf(workload);
      const production = bouncerScopes(policy.environmentGrants?.production?.scopes).sort();
      expect(production.length).toBeGreaterThan(0);
      expect(appScopes(caller).sort()).toEqual(production);
      expect(bouncerScopes(policy.scopes)).toEqual([]);
      for (const [environment, grant] of Object.entries(policy.environmentGrants ?? {})) {
        if (environment !== 'production') expect(bouncerScopes(grant?.scopes)).toEqual([]);
      }
    }
  );
});
