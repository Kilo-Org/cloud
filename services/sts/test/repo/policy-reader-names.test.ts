import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { experimental_readRawConfig } from 'wrangler';
import { PolicySchema } from '../../src/policy/schema';
import { repoRoot, shippedPolicyDocuments } from './repo';
import { parseWorkerConfig, workerConfigPaths, type WorkerConfig } from './worker-configs';

/**
 * A Worker that reads its runtime secrets through STS declares them in one place: the `BINDINGS`
 * map in its `src/secrets.ts`. Each entry is `STS lookup name -> the binding the deployment reads
 * today`; the lookup name is canonical (no environment suffix) and is both what the reader asks STS
 * for and what the policy grants, so it is the Infisical target. An entry's binding may be an
 * alias of that name (a prefixed or legacy binding name).
 *
 * The three artefacts must agree one-to-one:
 * - the policy's `secrets` list,
 * - the reader's `BINDINGS` keys,
 * - and the wrangler manifest: each entry's old binding must be the config's Secrets Store binding
 *   of that name, or a plain Worker secret (`wrangler secret put`), which the manifest cannot show,
 *   but never a `vars` entry.
 *
 * A name present in one place and absent from another fails only at cutover: the legacy read keeps
 * working while `sts` answers `not_granted`.
 *
 * Policies whose Worker has no `src/secrets.ts` keep their earlier reader shape (notifications,
 * o11y, audit-relay, migration-proxy) or live in another repository (bouncer-watch); their own
 * suites cover their names. A Worker that has the file must have the map.
 */

const BINDINGS_START = /^(?:export )?const BINDINGS = \{/m;

/** Readers with their own shape, covered by their own suites; each predates the `BINDINGS` map. */
const LEGACY_READERS: Record<string, true> = {
  notifications: true,
  o11y: true,
  'audit-relay': true,
};

/** The `BINDINGS` entries of a source file, or null when it has no such map. */
export function bindingEntries(source: string): Array<[stsName: string, binding: string]> | null {
  const start = BINDINGS_START.exec(source);
  if (start === null) return null;
  const end = source.indexOf('} as const;', start.index);
  if (end === -1) throw new Error('a BINDINGS map without an `} as const;` end');
  const body = source.slice(start.index, end);
  return [...body.matchAll(/^\s*([A-Z][A-Z0-9_]*): '([A-Z][A-Z0-9_]*)',/gm)].map(match => [
    match[1],
    match[2],
  ]);
}

/** Every Worker config, by the directory it is deployed from, and by its top-level name. */
function configs(): { byDir: Map<string, WorkerConfig>; dirOf: Map<string, string> } {
  const byDir = new Map<string, WorkerConfig>();
  const dirOf = new Map<string, string>();
  for (const path of workerConfigPaths(repoRoot)) {
    // Wrangler's own JSON, JSONC and TOML parser, the one a deploy uses.
    const raw = experimental_readRawConfig({ config: join(repoRoot, path) }).rawConfig;
    const parsed = parseWorkerConfig(path, raw);
    const dir = dirname(path);
    byDir.set(dir, parsed);
    if (parsed.config.name !== undefined) dirOf.set(parsed.config.name, dir);
  }
  return { byDir, dirOf };
}

describe('policy secrets match the reader that serves them', () => {
  const { byDir, dirOf } = configs();
  const readerOf = new Map<string, Array<[string, string]>>();
  const readerFileOf = new Map<string, string>();
  for (const [workload, dir] of dirOf) {
    const file = join(dir, 'src/secrets.ts');
    if (!existsSync(join(repoRoot, file))) continue;
    readerFileOf.set(workload, file);
    const entries = bindingEntries(readFileSync(join(repoRoot, file), 'utf8'));
    if (entries !== null) readerOf.set(workload, entries);
  }

  const policies = shippedPolicyDocuments()
    .map(({ file, document }) => ({ file, policy: PolicySchema.parse(document) }))
    .filter(({ policy }) => policy.identity.kind === 'worker-binding');

  it('reads at least one reader, so a parse change cannot make the check vacuous', () => {
    expect(readerOf.size).toBeGreaterThan(0);
  });

  for (const { file, policy } of policies) {
    const reader = readerOf.get(policy.workload);
    if (reader === undefined) {
      if (LEGACY_READERS[policy.workload] === true) continue;
      const readerFile = readerFileOf.get(policy.workload);
      if (readerFile === undefined) continue;
      it(`${file} has a reader with the BINDINGS map the policy grants`, () => {
        throw new Error(`${readerFile} has no BINDINGS map`);
      });
      continue;
    }
    it(`${file} grants exactly the names ${policy.workload} reads`, () => {
      expect(reader.map(([stsName]) => stsName).sort()).toEqual([...policy.secrets].sort());
    });
  }

  for (const [workload, reader] of readerOf) {
    it(`${workload} maps each lookup name to a secret of its own manifest`, () => {
      const dir = dirOf.get(workload);
      const worker = dir === undefined ? undefined : byDir.get(dir);
      if (worker === undefined) throw new Error(`${workload} has no config`);
      const vars = new Set(Object.keys(worker.config.vars ?? {}));
      const storeBindings = new Set(
        (worker.config.secrets_store_secrets ?? []).map(secret => secret.binding)
      );
      expect(new Set(reader.map(([stsName]) => stsName)).size).toBe(reader.length);
      for (const [stsName, binding] of reader) {
        expect(vars.has(binding), `${workload}: ${binding} is a var, not a secret`).toBe(false);
        // A Secrets Store binding is in the manifest; a plain Worker secret is not, so it is
        // accepted when the manifest names neither a var nor a store binding of that name.
        const known = storeBindings.has(binding) || !vars.has(binding);
        expect(known, `${workload}: ${stsName} -> ${binding} is not a secret of its config`).toBe(
          true
        );
      }
    });
  }

  it('serves every reader from an active policy', () => {
    const granted = new Set(policies.map(({ policy }) => policy.workload));
    expect([...readerOf.keys()].filter(workload => !granted.has(workload))).toEqual([]);
  });
});
