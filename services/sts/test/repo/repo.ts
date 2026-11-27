import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { isRegistrationDocument } from '../../src/policy/schema';

export const serviceRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const repoRoot = join(serviceRoot, '..', '..');
export const policyDir = join(serviceRoot, 'policy');

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
