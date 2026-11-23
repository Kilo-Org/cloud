import type { BenchmarkCaseInvocation } from '@kilocode/auto-routing-contracts';
import { bytesToBase64url } from '@kilocode/worker-utils/base64url';
import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_CASE_CAPABILITY_TTL_MS,
  BENCHMARK_CASE_HEADER,
  issueCaseInferenceCapability,
  verifyCaseInferenceCapability,
} from './case-inference-capability';

const invocation: BenchmarkCaseInvocation = {
  engineIdentity: 'efficient:v1:fixture',
  runId: 'decider-fixture',
  model: 'fixture/model',
  variant: 'low',
  caseId: 'case-1',
  repetition: 0,
  generation: 1,
  startedAt: 1_800_000_000_000,
};
const secret = 'synthetic-case-inference-secret';

async function signedHeaders() {
  const issued = await issueCaseInferenceCapability(secret, invocation);
  return new Headers({
    authorization: issued.authorization,
    [BENCHMARK_CASE_HEADER]: issued.invocationHeader,
  });
}

describe('benchmark inference capability', () => {
  it('authenticates the exact launched generation until its deadline', async () => {
    const headers = await signedHeaders();
    const deadline = invocation.startedAt + BENCHMARK_CASE_CAPABILITY_TTL_MS;
    expect(await verifyCaseInferenceCapability(secret, headers, deadline - 1)).toEqual(invocation);
    expect(await verifyCaseInferenceCapability(secret, headers, deadline)).toBeNull();
  });

  it.each<Partial<BenchmarkCaseInvocation>>([
    { engineIdentity: 'frontier:v1:fixture' },
    { runId: 'another-run' },
    { model: 'fixture/another-model' },
    { variant: '' },
    { caseId: 'another-case' },
    { repetition: 1 },
    { generation: 2 },
    { startedAt: invocation.startedAt + 1 },
  ])('rejects a validly encoded claim altered to %o', async change => {
    const headers = await signedHeaders();
    headers.set(
      BENCHMARK_CASE_HEADER,
      bytesToBase64url(new TextEncoder().encode(JSON.stringify({ ...invocation, ...change })))
    );
    expect(
      await verifyCaseInferenceCapability(secret, headers, invocation.startedAt + 1)
    ).toBeNull();
  });

  it('rejects an invalid transport and does not accept a different signing key', async () => {
    const headers = await signedHeaders();
    expect(
      await verifyCaseInferenceCapability('different-key', headers, invocation.startedAt)
    ).toBeNull();
    headers.set(BENCHMARK_CASE_HEADER, '#invalid');
    expect(await verifyCaseInferenceCapability(secret, headers, invocation.startedAt)).toBeNull();
  });
});
