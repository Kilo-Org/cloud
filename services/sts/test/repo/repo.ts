import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const serviceRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const repoRoot = join(serviceRoot, '..', '..');
export const policyDir = join(serviceRoot, 'policy');

export function policyFileNames(): string[] {
  return readdirSync(policyDir)
    .filter(file => file.endsWith('.yaml'))
    .sort();
}

/** Every policy file as parsed YAML, before schema validation. */
export function shippedPolicyDocuments(): Array<{ file: string; document: unknown }> {
  return policyFileNames().map(file => {
    const document: unknown = parseYaml(readFileSync(join(policyDir, file), 'utf8'));
    return { file, document };
  });
}
