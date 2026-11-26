import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { POLICY_FILES } from '../../src/policy/registry';
import { PolicySchema, policyFileProblems } from '../../src/policy/schema';
import { policyFileNames, shippedPolicyDocuments } from './repo';

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
