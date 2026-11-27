import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { isRegistrationDocument } from '../../src/policy/schema';

export const serviceRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const repoRoot = join(serviceRoot, '..', '..');
export const policyDir = join(serviceRoot, 'policy');

/**
 * The names whose value is one value across Workloads, so the copier keeps a single copy in
 * `/shared`. Every other policy name is a credential of one Workload and lives in its own
 * `/workloads/<workload>` folder; STS resolves that folder before `/shared`, so same-named
 * per-Workload credentials (the R2 pairs of `user-data-export` and `kilo-chat`) must stay out of
 * `/shared`. Both copier tables import this one list, because a folder decided differently in two
 * tables would let a co-located `/shared` value serve the wrong Workload.
 */
export const SHARED_SECRET_NAMES: readonly string[] = [
  'INTERNAL_API_SECRET',
  'NEXTAUTH_SECRET',
  'CALLBACK_TOKEN_SECRET',
];

export function policyFileNames(): string[] {
  return readdirSync(policyDir)
    .filter(file => file.endsWith('.yaml'))
    .sort();
}

/** Every file in the policy directory as text, keyed by file name, as `loadPolicies` takes it. */
export function shippedPolicySources(): Record<string, string> {
  return Object.fromEntries(
    policyFileNames().map(file => [file, readFileSync(join(policyDir, file), 'utf8')])
  );
}

function shippedDocuments(): Array<{ file: string; document: unknown }> {
  return Object.entries(shippedPolicySources()).map(([file, source]) => {
    const document: unknown = parseYaml(source);
    return { file, document };
  });
}

/** Every policy file as parsed YAML, before schema validation; registrations are left out. */
export function shippedPolicyDocuments(): Array<{ file: string; document: unknown }> {
  return shippedDocuments().filter(({ document }) => !isRegistrationDocument(document));
}

/** Every registration file as parsed YAML, before schema validation. */
export function shippedRegistrationDocuments(): Array<{ file: string; document: unknown }> {
  return shippedDocuments().filter(({ document }) => isRegistrationDocument(document));
}
