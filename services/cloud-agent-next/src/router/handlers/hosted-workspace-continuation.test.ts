import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';

import { appRouter } from '../../router.js';
import {
  ContinueHostedWorkspaceInput,
  ContinueHostedWorkspaceOutput,
  continuationError,
  continuationRequestDigest,
  deriveContinuationKey,
} from './hosted-workspace-continuation.js';

const SOURCE_A = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const SOURCE_B = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';

const validInput = {
  operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  clientProvenance: 'agent-manager' as const,
  repository: { type: 'github' as const, repo: 'Kilo-Org/cloud', branch: 'main' },
  activeSourceKiloSessionId: SOURCE_B,
  sessions: [
    { sourceKiloSessionId: SOURCE_A, agent: { mode: 'code', model: 'anthropic/claude-sonnet-4' } },
    {
      sourceKiloSessionId: SOURCE_B,
      agent: { mode: 'architect', model: 'anthropic/claude-opus-4', variant: '' },
    },
  ],
};

function parsed(overrides: Record<string, unknown> = {}) {
  return ContinueHostedWorkspaceInput.parse({ ...validInput, ...overrides });
}

describe('continueHostedWorkspace input schema', () => {
  it('registers the mutation on the app router', () => {
    expect(appRouter.continueHostedWorkspace).toBeDefined();
  });

  it('accepts a valid request with an empty variant', () => {
    expect(ContinueHostedWorkspaceInput.safeParse(validInput).success).toBe(true);
  });

  it('rejects duplicate source ids', () => {
    const result = ContinueHostedWorkspaceInput.safeParse({
      ...validInput,
      sessions: [
        validInput.sessions[0],
        { ...validInput.sessions[1], sourceKiloSessionId: SOURCE_A },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an active source that is not in the list', () => {
    const result = ContinueHostedWorkspaceInput.safeParse({
      ...validInput,
      activeSourceKiloSessionId: 'ses_cccccccccccccccccccccccccc',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty list and a list over the cap', () => {
    expect(ContinueHostedWorkspaceInput.safeParse({ ...validInput, sessions: [] }).success).toBe(
      false
    );
    const tooMany = Array.from({ length: 11 }, (_, index) => ({
      sourceKiloSessionId: `ses_${String(index).padStart(26, 'a')}`,
      agent: { mode: 'code', model: 'anthropic/claude-sonnet-4' },
    }));
    expect(
      ContinueHostedWorkspaceInput.safeParse({
        ...validInput,
        sessions: tooMany,
        activeSourceKiloSessionId: tooMany[0]?.sourceKiloSessionId,
      }).success
    ).toBe(false);
  });

  it('rejects an over-long mode or variant and a non-agent-manager provenance', () => {
    expect(
      ContinueHostedWorkspaceInput.safeParse({
        ...validInput,
        sessions: [
          { sourceKiloSessionId: SOURCE_A, agent: { mode: 'x'.repeat(51), model: 'a/b' } },
        ],
        activeSourceKiloSessionId: SOURCE_A,
      }).success
    ).toBe(false);
    expect(
      ContinueHostedWorkspaceInput.safeParse({
        ...validInput,
        sessions: [
          {
            sourceKiloSessionId: SOURCE_A,
            agent: { mode: 'code', model: 'a/b', variant: 'x'.repeat(51) },
          },
        ],
        activeSourceKiloSessionId: SOURCE_A,
      }).success
    ).toBe(false);
    expect(
      ContinueHostedWorkspaceInput.safeParse({ ...validInput, clientProvenance: 'browser' }).success
    ).toBe(false);
  });

  it('rejects a plaintext generic git token and accepts a token-less repository', () => {
    expect(
      ContinueHostedWorkspaceInput.safeParse({
        ...validInput,
        repository: { type: 'git', url: 'https://example.com/repo.git', token: 'secret' },
      }).success
    ).toBe(false);
    expect(
      ContinueHostedWorkspaceInput.safeParse({
        ...validInput,
        repository: { type: 'git', url: 'https://example.com/repo.git' },
      }).success
    ).toBe(true);
  });

  it.each([
    'https://user:secret@example.com/repo.git',
    'https://user@example.com/repo.git',
    'https://:secret@example.com/repo.git',
  ])('rejects generic git URL userinfo: %s', url => {
    expect(
      ContinueHostedWorkspaceInput.safeParse({
        ...validInput,
        repository: { type: 'git', url },
      }).success
    ).toBe(false);
  });
});

describe('continuation request digest', () => {
  it('is deterministic for the same request and organization', async () => {
    const first = await continuationRequestDigest(parsed(), null);
    const again = await continuationRequestDigest(parsed(), null);
    expect(first).toBe(again);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with the branch, agent, active source, or organization', async () => {
    const base = await continuationRequestDigest(parsed(), null);
    expect(
      await continuationRequestDigest(
        parsed({ repository: { ...validInput.repository, branch: 'other' } }),
        null
      )
    ).not.toBe(base);
    expect(
      await continuationRequestDigest(
        parsed({
          sessions: [
            {
              sourceKiloSessionId: SOURCE_A,
              agent: { mode: 'ask', model: 'anthropic/claude-sonnet-4' },
            },
            validInput.sessions[1],
          ],
        }),
        null
      )
    ).not.toBe(base);
    expect(
      await continuationRequestDigest(parsed({ activeSourceKiloSessionId: SOURCE_A }), null)
    ).not.toBe(base);
    expect(
      await continuationRequestDigest(parsed(), '11111111-1111-4111-8111-111111111111')
    ).not.toBe(base);
  });

  it('distinguishes an empty variant from an absent variant', async () => {
    const withEmpty = await continuationRequestDigest(parsed(), null);
    const absent = await continuationRequestDigest(
      parsed({
        sessions: [
          validInput.sessions[0],
          {
            sourceKiloSessionId: SOURCE_B,
            agent: { mode: 'architect', model: 'anthropic/claude-opus-4' },
          },
        ],
      }),
      null
    );
    expect(withEmpty).not.toBe(absent);
  });
});

describe('continuation helpers', () => {
  it('derives a deterministic UUID from the parent key, index and source', async () => {
    const first = await deriveContinuationKey(validInput.operationKey, 1, SOURCE_B);
    const again = await deriveContinuationKey(validInput.operationKey, 1, SOURCE_B);
    const otherIndex = await deriveContinuationKey(validInput.operationKey, 2, SOURCE_B);
    expect(first).toBe(again);
    expect(first).not.toBe(otherIndex);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('maps continuation codes to HTTP codes with a retryable flag', () => {
    const conflict = continuationError('operation_key_reuse_mismatch', false);
    expect(conflict).toBeInstanceOf(TRPCError);
    expect(conflict.code).toBe('CONFLICT');
    expect((conflict.cause as unknown as { retryable: boolean }).retryable).toBe(false);
    expect(continuationError('insufficient_balance', false).code).toBe('PAYMENT_REQUIRED');
    expect(continuationError('organization_mismatch', false).code).toBe('FORBIDDEN');
    expect(continuationError('continuation_incomplete', true).code).toBe('CONFLICT');
    expect(
      (continuationError('creation_in_progress', true).cause as unknown as { retryable: boolean })
        .retryable
    ).toBe(true);
  });

  it('validates the output shape with the required fields', () => {
    const result = ContinueHostedWorkspaceOutput.safeParse({
      workspaceId: 'worktree_11111111-1111-4111-8111-111111111111',
      sessions: [
        {
          sourceKiloSessionId: SOURCE_A,
          kiloSessionId: SOURCE_A,
          cloudAgentSessionId: 'workspace_11111111-1111-4111-8111-111111111111',
          agent: { mode: 'code', model: 'anthropic/claude-sonnet-4', variant: '' },
          modeFallback: true,
        },
      ],
      activeKiloSessionId: SOURCE_A,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an output that returns replayed:false', () => {
    const result = ContinueHostedWorkspaceOutput.safeParse({
      workspaceId: 'worktree_11111111-1111-4111-8111-111111111111',
      sessions: [],
      activeKiloSessionId: SOURCE_A,
      replayed: false,
    });
    expect(result.success).toBe(false);
  });
});
