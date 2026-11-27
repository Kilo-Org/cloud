import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOUNCER_APP_SCOPES, type BouncerCaller } from './sts-auth-contract';

// The scopes each app installs (`installBouncerAuth` reads `BOUNCER_APP_SCOPES`) must be exactly
// the Bouncer scopes its STS policy grants in production, or the app would mint a scope STS denies
// or never send one it holds. The policy files live in `services/sts/policy`; this package cannot
// import a YAML parser, so the test reads the one block it needs.

const POLICY_DIR = join(__dirname, '../../../../../services/sts/policy');

/** The `bouncer:` scopes under `environmentGrants.production.scopes` of one policy file. */
function productionBouncerScopes(file: string): string[] {
  const lines = readFileSync(join(POLICY_DIR, file), 'utf8').split('\n');
  const grants = lines.indexOf('environmentGrants:');
  if (grants === -1) throw new Error(`${file} has no environmentGrants`);
  const production = lines.indexOf('  production:', grants);
  if (production === -1) throw new Error(`${file} grants nothing in production`);
  const scopes = lines.indexOf('    scopes:', production);
  if (scopes === -1) throw new Error(`${file} grants no production scope`);
  const found: string[] = [];
  for (const line of lines.slice(scopes + 1)) {
    const item = /^ {6}- (\S+)$/.exec(line);
    if (item === null) break;
    found.push(item[1]);
  }
  return found.filter(scope => scope.startsWith('bouncer:'));
}

describe('BOUNCER_APP_SCOPES', () => {
  it.each([
    ['kilocode-app', 'web.yaml'],
    ['kilocode-ai-gateway', 'ai-gateway.yaml'],
  ] as const satisfies readonly (readonly [BouncerCaller, string])[])(
    'gives %s exactly the production Bouncer grant of %s',
    (caller, file) => {
      const granted = productionBouncerScopes(file);
      expect(granted.length).toBeGreaterThan(0);
      expect([...BOUNCER_APP_SCOPES[caller]].sort()).toEqual([...granted].sort());
    }
  );
});
