import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STS_DENIED_PROBE_APL_EXCLUSION } from '@kilocode/sts-contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { POLICY_FILES } from '../../src/policy/registry';
import { PolicySchema, policyFileProblems } from '../../src/policy/schema';
import { policyFileNames, repoRoot, serviceRoot, shippedPolicyDocuments } from './repo';

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
