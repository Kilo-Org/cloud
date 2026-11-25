import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseJsonc } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { POLICY_FILES } from '../../src/policy/registry';
import { PolicySchema, policyFileProblems } from '../../src/policy/schema';

const serviceRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const policyDir = join(serviceRoot, 'policy');
const servicesDir = join(serviceRoot, '..');

const BindingSchema = z.object({
  binding: z.string(),
  service: z.string(),
  entrypoint: z.string().optional(),
  props: z.record(z.string(), z.unknown()).optional(),
});

const BlockSchema = z.object({
  name: z.string().optional(),
  services: z.array(BindingSchema).optional(),
  env: z.record(z.string(), z.unknown()).optional(),
});

type Binding = z.infer<typeof BindingSchema>;

type ConfiguredBinding = {
  where: string;
  /** The consumer's top-level worker name; `props.caller` carries this in every environment. */
  callerName: string;
  /** `production` for the top-level block, otherwise the wrangler environment name. */
  envName: string;
  binding: Binding;
};

function serviceBindings(): ConfiguredBinding[] {
  const found: ConfiguredBinding[] = [];
  for (const entry of readdirSync(servicesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const relative = `services/${entry.name}/wrangler.jsonc`;
    const configPath = join(servicesDir, entry.name, 'wrangler.jsonc');
    if (!existsSync(configPath)) continue;

    const root = BlockSchema.parse(parseJsonc(readFileSync(configPath, 'utf8')));
    if (root.name === undefined) throw new Error(`${relative} has no name`);
    for (const binding of root.services ?? []) {
      found.push({
        where: `${relative} (production)`,
        callerName: root.name,
        envName: 'production',
        binding,
      });
    }
    for (const [envName, raw] of Object.entries(root.env ?? {})) {
      const block = BlockSchema.parse(raw);
      for (const binding of block.services ?? []) {
        found.push({
          where: `${relative} (env.${envName})`,
          callerName: root.name,
          envName,
          binding,
        });
      }
    }
  }
  return found;
}

function shippedPolicies(): Array<{ file: string; document: unknown }> {
  return readdirSync(policyDir)
    .filter(file => file.endsWith('.yaml'))
    .map(file => ({ file, document: parseYaml(readFileSync(join(policyDir, file), 'utf8')) }));
}

describe('policy files', () => {
  it('registers every file in the policy directory and no other', () => {
    const onDisk = readdirSync(policyDir)
      .filter(file => file.endsWith('.yaml'))
      .sort();
    expect(onDisk).toEqual([...POLICY_FILES].sort());
  });

  it('validates every shipped file against the strict schema', () => {
    for (const { file, document } of shippedPolicies()) {
      const parsed = PolicySchema.safeParse(document);
      if (!parsed.success) {
        throw new Error(`${file}: ${parsed.error.message}`);
      }
      expect(policyFileProblems(parsed.data)).toEqual([]);
      expect(file).toBe(`${parsed.data.workload}.yaml`);
    }
  });

  it('uses canonical secret names with no environment suffix', () => {
    for (const { file, document } of shippedPolicies()) {
      const policy = PolicySchema.parse(document);
      for (const name of policy.secrets) {
        expect(name, `${file} secret ${name}`).not.toMatch(/_(PROD|STAGING|DEV|DEVELOPMENT)$/);
      }
    }
  });
});

describe('STS service bindings', () => {
  it('names the consumer worker itself in props.caller, in every environment', () => {
    const problems = serviceBindings()
      .filter(({ binding }) => binding.service === 'sts' || binding.service === 'sts-staging')
      .filter(({ binding }) => binding.entrypoint === 'SecretsBroker')
      .filter(({ binding, callerName }) => binding.props?.caller !== callerName)
      .map(
        ({ where, callerName, binding }) =>
          `${where}: ${binding.binding} targets ${binding.service} with caller ${String(
            binding.props?.caller
          )}, expected ${callerName}`
      );
    expect(problems).toEqual([]);
  });

  it('points a staging environment at sts-staging and the production block at sts', () => {
    const problems = serviceBindings()
      .filter(({ binding }) => binding.service === 'sts' || binding.service === 'sts-staging')
      .filter(({ binding, envName }) => {
        if (envName === 'production') return binding.service !== 'sts';
        if (envName === 'staging') return binding.service !== 'sts-staging';
        return false;
      })
      .map(({ where, envName, binding }) => `${where}: env ${envName} binds ${binding.service}`);
    expect(problems).toEqual([]);
  });

  it('gives every STS caller a worker-binding policy', () => {
    const policies = shippedPolicies().map(({ document }) => PolicySchema.parse(document));
    const workerBinding = new Set(
      policies
        .filter(policy => policy.identity.kind === 'worker-binding')
        .map(policy => policy.workload)
    );
    const problems = serviceBindings()
      .filter(({ binding }) => binding.service === 'sts' || binding.service === 'sts-staging')
      .filter(({ callerName }) => !workerBinding.has(callerName))
      .map(
        ({ where, callerName }) => `${where}: no worker-binding policy for caller ${callerName}`
      );
    expect(problems).toEqual([]);
  });
});
