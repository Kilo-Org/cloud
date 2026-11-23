import { describe, it, expect } from 'vitest';
import {
  BENCHMARK_PLATFORM_PROJECT_ID,
  BENCHMARK_PROJECT_PREFIX,
  benchmarkProjectId,
  isBenchmarkProjectId,
  parseBenchmarkProjectId,
} from './benchmark-project';
import { BenchmarkGatewayAssignmentSchema } from './benchmark-inference';

const ROUTER_ID = '6f1c2f3a-1111-4a2b-8c3d-4e5f60718293';

describe('benchmark project id', () => {
  it('formats and round-trips a pool id', () => {
    const id = benchmarkProjectId({ scope: 'org', slug: 'my-pool', routerId: ROUTER_ID });
    expect(id).toBe(`${BENCHMARK_PROJECT_PREFIX} / org/my-pool/${ROUTER_ID}`);
    expect(parseBenchmarkProjectId(id)).toEqual({
      scope: 'org',
      slug: 'my-pool',
      routerId: ROUTER_ID,
    });
  });

  it('refuses to emit an unparseable id', () => {
    expect(() =>
      benchmarkProjectId({ scope: 'user', slug: 'Bad Slug', routerId: ROUTER_ID })
    ).toThrow();
    expect(() =>
      benchmarkProjectId({ scope: 'user', slug: 'ok', routerId: 'not-a-uuid' })
    ).toThrow();
  });

  it('rejects lookalikes instead of accepting a bare prefix', () => {
    for (const value of [
      `${BENCHMARK_PROJECT_PREFIX} / junk`,
      `${BENCHMARK_PROJECT_PREFIX} / user/pool/not-a-uuid`,
      `${BENCHMARK_PROJECT_PREFIX} / user/Bad/pool/${ROUTER_ID}`,
      `${BENCHMARK_PROJECT_PREFIX} / team/p/${ROUTER_ID}`,
      'handbook',
      null,
    ]) {
      expect(parseBenchmarkProjectId(value)).toBeNull();
      expect(isBenchmarkProjectId(value)).toBe(false);
    }
  });

  it('treats the platform value as reserved but not a pool', () => {
    expect(isBenchmarkProjectId(BENCHMARK_PLATFORM_PROJECT_ID)).toBe(true);
    expect(parseBenchmarkProjectId(BENCHMARK_PLATFORM_PROJECT_ID)).toBeNull();
  });
});

describe('benchmark assignment schema', () => {
  const base = {
    engineIdentity: 'engine',
    runId: 'run',
    model: 'openai/gpt-4o',
    variant: '',
    caseId: 'case',
    repetition: 0,
    generation: 1,
    startedAt: 1,
    api: 'chat/completions' as const,
    modelRequestId: '11111111-1111-4111-8111-111111111111',
    assignmentId: '22222222-2222-4222-8222-222222222222',
    requestId: '33333333-3333-4333-8333-333333333333',
    usageId: '44444444-4444-4444-8444-444444444444',
    payer: { type: 'user' as const, id: 'user-1' },
    actorUserId: 'user-1',
    executorUserId: 'bot',
    platformOrganizationId: null,
  };

  it('accepts a coherent paid assignment', () => {
    const parsed = BenchmarkGatewayAssignmentSchema.safeParse({
      ...base,
      projectId: benchmarkProjectId({ scope: 'user', slug: 'p', routerId: ROUTER_ID }),
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a payer without a paid request, and a paid request without a payer', () => {
    expect(
      BenchmarkGatewayAssignmentSchema.safeParse({
        ...base,
        requestId: null,
        projectId: BENCHMARK_PLATFORM_PROJECT_ID,
        platformOrganizationId: null,
      }).success
    ).toBe(false);
    expect(
      BenchmarkGatewayAssignmentSchema.safeParse({
        ...base,
        payer: null,
        projectId: BENCHMARK_PLATFORM_PROJECT_ID,
      }).success
    ).toBe(false);
  });

  it('requires the platform project for a platform call and a matching pool scope otherwise', () => {
    expect(
      BenchmarkGatewayAssignmentSchema.safeParse({
        ...base,
        payer: null,
        requestId: null,
        projectId: BENCHMARK_PLATFORM_PROJECT_ID,
        platformOrganizationId: '7a1c2f3a-1111-4a2b-8c3d-4e5f60718293',
      }).success
    ).toBe(true);
    // org payer with a user-scope project is refused
    expect(
      BenchmarkGatewayAssignmentSchema.safeParse({
        ...base,
        payer: { type: 'organization', id: 'org-1' },
        actorUserId: 'actor-1',
        projectId: benchmarkProjectId({ scope: 'user', slug: 'p', routerId: ROUTER_ID }),
      }).success
    ).toBe(false);
  });

  it('requires a personal payer to be its own actor', () => {
    expect(
      BenchmarkGatewayAssignmentSchema.safeParse({
        ...base,
        actorUserId: 'someone-else',
        projectId: benchmarkProjectId({ scope: 'user', slug: 'p', routerId: ROUTER_ID }),
      }).success
    ).toBe(false);
  });
});
