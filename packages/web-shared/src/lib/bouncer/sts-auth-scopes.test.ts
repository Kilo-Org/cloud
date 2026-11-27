import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOUNCER_APP_SCOPES, type BouncerCaller } from './sts-auth-contract';

// The scopes each app installs (`installBouncerAuth` reads `BOUNCER_APP_SCOPES`) must be exactly
// the Bouncer scopes its STS policy grants in production, or the app would mint a scope STS denies
// or never send one it holds. The policy files live in `services/sts/policy`; this package cannot
// import a YAML parser, so the test reads the lines it needs.

const POLICY_DIR = join(__dirname, '../../../../../services/sts/policy');

function policyLines(file: string): string[] {
  return readFileSync(join(POLICY_DIR, file), 'utf8').split('\n');
}

/** The `bouncer:` scopes under `environmentGrants.production.scopes` of one policy file. */
function productionBouncerScopes(file: string): string[] {
  const lines = policyLines(file);
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

/** Every `bouncer:` list item anywhere in one policy file: top level, any environment. */
function everyBouncerScope(file: string): string[] {
  return policyLines(file).flatMap(line => /^\s*- (bouncer:\S+)$/.exec(line)?.[1] ?? []);
}

describe('BOUNCER_APP_SCOPES', () => {
  it.each([
    ['kilocode-app', 'web.yaml'],
    ['kilocode-ai-gateway', 'ai-gateway.yaml'],
  ] as const satisfies readonly (readonly [BouncerCaller, string])[])(
    'gives %s exactly the production Bouncer grant of %s, which no other place in it widens',
    (caller, file) => {
      const granted = productionBouncerScopes(file);
      expect(granted.length).toBeGreaterThan(0);
      expect([...BOUNCER_APP_SCOPES[caller]].sort()).toEqual([...granted].sort());
      // A `bouncer:` scope at the top level or in another environment would reach staging or
      // development STS too; Bouncer runs in production only.
      expect(everyBouncerScope(file).sort()).toEqual([...granted].sort());
    }
  );
});
