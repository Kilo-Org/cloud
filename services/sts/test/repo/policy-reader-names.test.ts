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
 * - and the wrangler manifest: an entry's binding may never be a `vars` entry, and where the
 *   manifest declares a Secrets Store binding of that name, its `secret_name` is the canonical name
 *   or that name with the `_PROD` alias.
 *
 * A name present in one place and absent from another fails only at cutover: the legacy read keeps
 * working while `sts` answers `not_granted`.
 *
 * Readers declare one of two map shapes and both are checked the same way: `BINDINGS` (the
 * canonical name an STS reader asks for) and the earlier `SECRETS_STORE_BINDINGS`, so a sibling
 * batch that has not renamed its map yet is still checked instead of failing the parse.
 * `migration-proxy` and `bouncer-watch` have no `src/secrets.ts` here (`bouncer-watch` lives in
 * another repository); `o11y`, `audit-relay` and `cloudflare-webhook-agent-ingest` declare no map
 * at all — their names are a type union, one name per binding — so their own suites cover them.
 * A config is enumerated by its top-level `name`; one that names its deployment only inside `env`
 * (`notifications`) is not reached here and stays covered by its own suite.
 */

/** The map shapes a reader may declare; a source file carries at most one of them. */
const BINDINGS_MAPS = [
  /^(?:export )?const BINDINGS = \{/m,
  /^(?:export )?const SECRETS_STORE_BINDINGS = \{/m,
];

/** The map's entries of a source file, or null when it declares no such map. */
function bindingEntries(source: string): Array<[stsName: string, binding: string]> | null {
  for (const start of BINDINGS_MAPS) {
    const found = start.exec(source);
    if (found === null) continue;
    const end = source.indexOf('} as const;', found.index);
    if (end === -1)
      throw new Error(`a map matching ${String(start)} without an \`} as const;\` end`);
    const body = source.slice(found.index, end);
    return [...body.matchAll(/^\s*([A-Z][A-Z0-9_]*): '([A-Z][A-Z0-9_]*)',/gm)].map(match => [
      match[1],
      match[2],
    ]);
  }
  return null;
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
  for (const [workload, dir] of dirOf) {
    const file = join(dir, 'src/secrets.ts');
    if (!existsSync(join(repoRoot, file))) continue;
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
    // No map in either shape: the reader names its secrets one per binding, so its own suite is
    // the only place that can pin them.
    if (reader === undefined) continue;
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
      const storeEntries = worker.config.secrets_store_secrets ?? [];
      expect(new Set(reader.map(([stsName]) => stsName)).size).toBe(reader.length);
      for (const [stsName, binding] of reader) {
        expect(vars.has(binding), `${workload}: ${binding} is a var, not a secret`).toBe(false);
        // A Secrets Store binding is in the manifest, and the entry behind it must carry the name
        // of the secret it holds: the canonical lookup name or its `_PROD` alias when the binding
        // is that name, and the binding's own name or its `_PROD` alias when the binding is a
        // prefixed or legacy alias of the lookup name. Otherwise the copier copies a different
        // secret than the policy grants. A plain Worker secret (`wrangler secret put`) has no
        // manifest entry at all: only the deployment holds it, and the Worker's own reader suite
        // pins the binding names it reads.
        const entry = storeEntries.find(secret => secret.binding === binding);
        if (entry !== undefined) {
          const names =
            binding === stsName || binding === `${stsName}_PROD`
              ? [stsName, `${stsName}_PROD`]
              : [binding, `${binding}_PROD`];
          expect(names, `${workload}: ${stsName} -> ${binding}`).toContain(entry.secret_name);
        }
      }
    });
  }

  it('serves every reader from an active policy', () => {
    const granted = new Set(policies.map(({ policy }) => policy.workload));
    expect([...readerOf.keys()].filter(workload => !granted.has(workload))).toEqual([]);
  });
});
