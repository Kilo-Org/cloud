import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STS_DENIED_PROBE_APL_EXCLUSION, STS_ENVIRONMENTS } from '@kilocode/sts-contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadPolicies } from '../../src/policy/load';
import { POLICY_FILES } from '../../src/policy/registry';
import {
  PolicySchema,
  PolicySnapshotSchema,
  RegistrationSchema,
  policyFileProblems,
} from '../../src/policy/schema';
import {
  policyFileNames,
  repoRoot,
  serviceRoot,
  shippedPolicyDocuments,
  shippedPolicySources,
  shippedRegistrationDocuments,
} from './repo';

describe('policy files', () => {
  it('registers every file in the policy directory and no other', () => {
    expect(policyFileNames()).toEqual([...POLICY_FILES].sort());
  });

  it('names each file after its workload and passes the strict schema and cross-field checks', () => {
    for (const { file, document } of shippedPolicyDocuments()) {
      const parsed = PolicySchema.safeParse(document);
      if (!parsed.success) throw new Error(`${file}: ${z.prettifyError(parsed.error)}`);
      expect(file).toBe(`${parsed.data.workload}.yaml`);
      expect(policyFileProblems(parsed.data), file).toEqual([]);
    }
  });
});

describe('registration files', () => {
  it('name each file after its workload, pass the strict schema and share no name with a policy', () => {
    const policies = new Set(
      shippedPolicyDocuments().map(({ document }) => PolicySchema.parse(document).workload)
    );
    for (const { file, document } of shippedRegistrationDocuments()) {
      const parsed = RegistrationSchema.safeParse(document);
      if (!parsed.success) throw new Error(`${file}: ${z.prettifyError(parsed.error)}`);
      expect(file).toBe(`${parsed.data.workload}.yaml`);
      expect(policies.has(parsed.data.workload), file).toBe(false);
    }
  });

  it('change nothing STS serves, admits, bundles, audits or hashes in any environment', async () => {
    const sources = shippedPolicySources();
    const registrationFiles = new Set(shippedRegistrationDocuments().map(({ file }) => file));
    const shipped = loadPolicies(sources);
    const policiesOnly = loadPolicies(
      Object.fromEntries(Object.entries(sources).filter(([file]) => !registrationFiles.has(file)))
    );
    const registered = shipped.registered();
    expect([...registered].sort()).toEqual(
      [...registrationFiles].map(file => file.replace(/\.yaml$/, '')).sort()
    );
    expect(policiesOnly.registered()).toEqual([]);

    // Identity admission matches tokens against every file as written.
    expect(shipped.all()).toEqual(policiesOnly.all());
    const active = shipped.all().map(policy => policy.workload);
    expect(active.filter(workload => registered.includes(workload))).toEqual([]);
    for (const environment of STS_ENVIRONMENTS) {
      // The refresher's bundles, its policy.changed diff and the stored snapshot a rollback reads.
      expect(shipped.forEnvironment(environment)).toEqual(policiesOnly.forEnvironment(environment));
      const entries = shipped.snapshot(environment);
      expect(entries).toEqual(policiesOnly.snapshot(environment));
      expect(entries.map(entry => entry.workload)).toEqual(active);
      expect(PolicySnapshotSchema.safeParse(JSON.parse(JSON.stringify(entries))).success).toBe(
        true
      );
      expect(await shipped.hash(environment)).toBe(await policiesOnly.hash(environment));
      for (const workload of active) {
        expect(await shipped.workloadHash(environment, workload)).toBe(
          await policiesOnly.workloadHash(environment, workload)
        );
      }
      for (const workload of registered) {
        // Mint, bundle, lease and deploy-token decisions: no policy, so `unknown_workload`.
        expect(shipped.get(environment, workload)).toBeNull();
        expect(
          shipped.forEnvironment(environment).some(policy => policy.workload === workload)
        ).toBe(false);
        expect(await shipped.workloadHash(environment, workload)).toBe(
          await policiesOnly.workloadHash(environment, workload)
        );
      }
    }
    for (const workload of registered) expect(shipped.has(workload)).toBe(false);
  });
});

describe('denied-probe exclusion', () => {
  it('appears in the README monitor query exactly as the shared constant states it', () => {
    const readme = readFileSync(join(serviceRoot, 'README.md'), 'utf8');
    // The exclusion line itself and the monitor query that uses it.
    expect(readme.split(STS_DENIED_PROBE_APL_EXCLUSION)).toHaveLength(3);
    expect(readFileSync(join(repoRoot, 'services/usage-ingest/README.md'), 'utf8')).toContain(
      'STS_DENIED_PROBE_APL_EXCLUSION'
    );
  });
});
