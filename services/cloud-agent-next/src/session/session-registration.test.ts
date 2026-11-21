import { describe, expect, it, vi } from 'vitest';
import type {
  CreateSessionForCloudAgentParams,
  CreateSessionForCloudAgentResult,
} from '@kilocode/session-ingest-contracts';

import type { Env } from '../types.js';
import { createIngestOwnershipRow, ingestRejectionError } from './session-registration.js';

const cloneParams: CreateSessionForCloudAgentParams = {
  sessionId: 'ses_123456789abc123456789ABCDE',
  kiloUserId: 'usr_1',
  cloudAgentSessionId: 'workspace_12345678-1234-4234-8234-123456789012',
  createdOnPlatform: 'web',
  cloneFromKiloSessionId: 'ses_123456789abc123456789ABCDEF',
};

/** An env whose Session Ingest binding answers with the queued outcomes in order. */
function ingestionEnv(outcomes: Array<CreateSessionForCloudAgentResult | Error>) {
  const createSessionForCloudAgent = vi.fn();
  for (const outcome of outcomes) {
    if (outcome instanceof Error) {
      createSessionForCloudAgent.mockRejectedValueOnce(outcome);
    } else {
      createSessionForCloudAgent.mockResolvedValueOnce(outcome);
    }
  }
  return {
    createSessionForCloudAgent,
    env: { SESSION_INGEST: { createSessionForCloudAgent } } as unknown as Env,
  };
}

const ready = {
  status: 'ready' as const,
  clone: { sessionId: cloneParams.sessionId, copiedItemCount: 4 },
};

describe('ingestRejectionError', () => {
  it.each(['source_digest_changed', 'clone_setup_failed'] as const)(
    'reports %s as a retryable conflict',
    code => {
      const error = ingestRejectionError(code);
      expect(error.code).toBe('CONFLICT');
      expect(error.message).toBe(code);
    }
  );

  it.each([
    'source_access_denied',
    'organization_mismatch',
    'malformed_source_data',
    'missing_source_body',
    'destination_conflict',
    'clone_cut_not_found',
    'session_retired',
  ] as const)('keeps %s a request error', code => {
    expect(ingestRejectionError(code).code).toBe('BAD_REQUEST');
  });

  it('keeps a refused organization forbidden', () => {
    expect(ingestRejectionError('organization_access_denied').code).toBe('FORBIDDEN');
  });
});

describe('createIngestOwnershipRow', () => {
  it('copies the source again after the source changed under the first copy', async () => {
    const { createSessionForCloudAgent, env } = ingestionEnv([
      { status: 'rejected', code: 'source_digest_changed' },
      ready,
    ]);

    await expect(createIngestOwnershipRow(env, cloneParams)).resolves.toEqual(ready);
    expect(createSessionForCloudAgent).toHaveBeenCalledTimes(2);
    expect(createSessionForCloudAgent).toHaveBeenLastCalledWith(cloneParams);
  });

  it('reports the rejection when the second copy also finds a changed source', async () => {
    const changed = { status: 'rejected', code: 'source_digest_changed' } as const;
    const { createSessionForCloudAgent, env } = ingestionEnv([changed, changed]);

    await expect(createIngestOwnershipRow(env, cloneParams)).resolves.toEqual(changed);
    expect(createSessionForCloudAgent).toHaveBeenCalledTimes(2);
  });

  it.each(['clone_setup_failed', 'destination_conflict', 'malformed_source_data'] as const)(
    'does not copy again after %s',
    async code => {
      const { createSessionForCloudAgent, env } = ingestionEnv([{ status: 'rejected', code }]);

      await expect(createIngestOwnershipRow(env, cloneParams)).resolves.toEqual({
        status: 'rejected',
        code,
      });
      expect(createSessionForCloudAgent).toHaveBeenCalledTimes(1);
    }
  );

  it('does not copy again for a create that is not a clone', async () => {
    const { createSessionForCloudAgent, env } = ingestionEnv([
      { status: 'rejected', code: 'session_retired' },
    ]);
    const { cloneFromKiloSessionId: _clone, ...nonCloneParams } = cloneParams;

    await expect(createIngestOwnershipRow(env, nonCloneParams)).resolves.toEqual({
      status: 'rejected',
      code: 'session_retired',
    });
    expect(createSessionForCloudAgent).toHaveBeenCalledTimes(1);
  });

  it('leaves an in-progress copy to the caller', async () => {
    const { createSessionForCloudAgent, env } = ingestionEnv([{ status: 'in_progress' }]);

    await expect(createIngestOwnershipRow(env, cloneParams)).resolves.toEqual({
      status: 'in_progress',
    });
    expect(createSessionForCloudAgent).toHaveBeenCalledTimes(1);
  });

  it('never retries a failed RPC call', async () => {
    const { createSessionForCloudAgent, env } = ingestionEnv([new Error('binding failed')]);

    await expect(createIngestOwnershipRow(env, cloneParams)).rejects.toThrow('binding failed');
    expect(createSessionForCloudAgent).toHaveBeenCalledTimes(1);
  });
});
