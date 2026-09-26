import { describe, expect, it, jest } from '@jest/globals';
import {
  createWorktreeReviewSend,
  type WorktreeReviewConfiguration,
  type WorktreeReviewSubmission,
} from './worktree-review-send';

type Dependencies = Parameters<typeof createWorktreeReviewSend>[0];
type Target = Awaited<ReturnType<Dependencies['getSession']>>;
type MessageResult = NonNullable<Awaited<ReturnType<Dependencies['getMessageResult']>>>;

const kiloSessionId = 'ses_12345678901234567890123456';
const cloudAgentSessionId = 'workspace_12345678-1234-4234-9234-123456789abc';
const worktreeId = 'worktree_12345678-1234-4234-9234-123456789abc';
const organizationId = '12345678-1234-4234-9234-123456789abc';
const input = {
  destinationKiloSessionId: kiloSessionId,
  expectedWorktreeId: worktreeId,
  prompt: 'Review feedback',
};

function target(): Target {
  return {
    session_id: kiloSessionId,
    cloud_agent_session_id: cloudAgentSessionId,
    cloud_agent_worktree_id: worktreeId,
    organization_id: null,
    created_on_platform: 'cloud-agent-web',
    runtimeState: {
      sessionId: cloudAgentSessionId,
      kiloSessionId,
      preparedAt: 1,
      mode: 'code',
      model: 'model/target',
      variant: 'high',
    },
  };
}

function fixture(overrides: Partial<Dependencies> = {}) {
  const getSession = jest.fn<Dependencies['getSession']>(async () => target());
  const send = jest.fn<Dependencies['send']>(async submission => ({
    cloudAgentSessionId: submission.destinationCloudAgentSessionId,
    messageId: submission.messageId,
    delivery: 'sent',
  }));
  const getMessageResult = jest.fn<Dependencies['getMessageResult']>(async () => null);
  const api = createWorktreeReviewSend({ getSession, send, getMessageResult, ...overrides });
  return { ...api, getSession, send, getMessageResult };
}

function messageResult(
  submission: WorktreeReviewSubmission,
  status: MessageResult['status']
): MessageResult {
  return {
    cloudAgentSessionId: submission.destinationCloudAgentSessionId,
    messageId: submission.messageId,
    status,
    ...(status === 'queued' ? {} : { acceptedAt: 10 }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('worktree review destination preparation', () => {
  it('reads the authenticated target and freezes the destination, payload and message ID', async () => {
    const api = fixture();
    const submission = await api.prepareReviewSubmission(input);
    expect(api.getSession).toHaveBeenCalledWith(kiloSessionId);
    expect(api.send).not.toHaveBeenCalled();
    expect(submission).toMatchObject({
      destinationKiloSessionId: kiloSessionId,
      destinationCloudAgentSessionId: cloudAgentSessionId,
      expectedWorktreeId: worktreeId,
      payload: {
        type: 'prompt',
        prompt: input.prompt,
        mode: 'code',
        model: 'model/target',
        variant: 'high',
      },
    });
    expect(submission.messageId).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(Object.isFrozen(submission)).toBe(true);
    expect(Object.isFrozen(submission.payload)).toBe(true);
  });

  it('captures input before metadata arrives and never consults the active chat', async () => {
    const metadata = deferred<Target>();
    const api = fixture({ getSession: () => metadata.promise });
    const configuration: WorktreeReviewConfiguration = {
      mode: 'plan',
      model: 'model/selected',
      variant: 'low',
    };
    const mutableInput = { ...input, configuration };
    const preparing = api.prepareReviewSubmission(mutableInput);
    configuration.mode = 'ask';
    configuration.model = 'model/other-chat';
    configuration.variant = undefined;
    mutableInput.configuration = { mode: 'debug', model: 'model/foreground', variant: 'high' };
    mutableInput.prompt = 'Unrelated composer';
    mutableInput.destinationKiloSessionId = 'ses_abcdefghijklmnopqrstuvwxyz';
    mutableInput.expectedWorktreeId = 'worktree_22345678-1234-4234-9234-123456789abc';
    metadata.resolve(target());
    const submission = await preparing;
    await api.submitReview(submission);
    expect(api.send).toHaveBeenCalledWith(submission);
    expect(submission.payload.prompt).toBe(input.prompt);
    expect(submission.destinationKiloSessionId).toBe(kiloSessionId);
    expect(submission.payload).toMatchObject({
      mode: 'plan',
      model: 'model/selected',
      variant: 'low',
    });
  });

  it.each([undefined, 'low'])(
    'uses supplied active configuration without restoring the runtime variant (%s)',
    async variant => {
      const api = fixture();
      const submission = await api.prepareReviewSubmission({
        ...input,
        configuration: { mode: 'plan', model: 'model/selected', variant },
      });
      expect(submission.payload).toEqual({
        type: 'prompt',
        prompt: input.prompt,
        mode: 'plan',
        model: 'model/selected',
        variant,
      });
    }
  );

  it.each([undefined, 'low'])(
    'uses target runtime-agent model and variant pins (%s)',
    async variant => {
      const metadata = target();
      metadata.runtimeState = {
        ...metadata.runtimeState,
        sessionId: cloudAgentSessionId,
        preparedAt: 1,
        mode: 'reviewer',
        model: 'model/session',
        variant: 'high',
        runtimeAgents: [{ slug: 'reviewer', model: 'model/pinned', variant }],
      };
      const api = fixture({ getSession: async () => metadata });
      const submission = await api.prepareReviewSubmission(input);
      expect(submission.payload).toMatchObject({
        mode: 'reviewer',
        model: 'model/pinned',
        variant,
      });
    }
  );

  it.each([undefined, 'max'])(
    'applies fetched target agent pins over selected active configuration (%s)',
    async variant => {
      const metadata = target();
      if (!metadata.runtimeState) throw new Error('missing fixture');
      metadata.runtimeState.runtimeAgents = [{ slug: 'reviewer', model: 'model/pinned', variant }];
      const api = fixture({ getSession: async () => metadata });
      const submission = await api.prepareReviewSubmission({
        ...input,
        configuration: { mode: 'reviewer', model: 'model/selected', variant: 'low' },
      });
      expect(submission.payload).toMatchObject({
        mode: 'reviewer',
        model: 'model/pinned',
        variant,
      });
    }
  );

  it('keeps the selected variant when the fetched agent does not pin a model', async () => {
    const metadata = target();
    if (!metadata.runtimeState) throw new Error('missing fixture');
    metadata.runtimeState.runtimeAgents = [{ slug: 'reviewer', variant: 'max' }];
    const api = fixture({ getSession: async () => metadata });
    const submission = await api.prepareReviewSubmission({
      ...input,
      configuration: { mode: 'reviewer', model: 'model/selected', variant: 'low' },
    });
    expect(submission.payload).toMatchObject({
      mode: 'reviewer',
      model: 'model/selected',
      variant: 'low',
    });
  });

  it.each([
    { mode: 'unknown-agent', model: 'model/selected' },
    { mode: 'code', model: '' },
  ])(
    'does not bypass agent/model validation with selected configuration %j',
    async configuration => {
      const api = fixture();
      await expect(api.prepareReviewSubmission({ ...input, configuration })).rejects.toThrow(
        'The destination chat does not have an available agent and model.'
      );
      expect(api.send).not.toHaveBeenCalled();
    }
  );

  it('ignores an agent variant without a model pin', async () => {
    const metadata = target();
    if (!metadata.runtimeState) throw new Error('missing fixture');
    metadata.runtimeState.runtimeAgents = [{ slug: 'code', variant: 'low' }];
    const api = fixture({ getSession: async () => metadata });
    expect((await api.prepareReviewSubmission(input)).payload.variant).toBe('high');
  });

  it('allows a ready sibling with no previous turn in the same organization', async () => {
    const metadata = target();
    metadata.organization_id = organizationId;
    if (!metadata.runtimeState) throw new Error('missing fixture');
    metadata.runtimeState.orgId = organizationId;
    const api = fixture({ organizationId, getSession: async () => metadata });
    expect((await api.prepareReviewSubmission(input)).organizationId).toBe(organizationId);
  });

  it.each([undefined, organizationId])(
    'admits a registered lazy sibling without lifecycle preparation in scope %s',
    async scope => {
      const metadata = target();
      metadata.organization_id = scope ?? null;
      if (!metadata.runtimeState) throw new Error('missing fixture');
      metadata.runtimeState.preparedAt = undefined;
      metadata.runtimeState.orgId = scope;
      const api = fixture({ organizationId: scope, getSession: async () => metadata });
      const submission = await api.prepareReviewSubmission(input);
      expect(api.send).not.toHaveBeenCalled();
      expect(submission.destinationKiloSessionId).toBe(kiloSessionId);
      expect(submission.payload.model).toBe('model/target');
      expect(await api.submitReview(submission)).toEqual({ status: 'accepted', delivery: 'sent' });
      expect(api.send.mock.calls).toEqual([[submission]]);
    }
  );

  it.each([
    ['source', 'ses_fa35bdf46fffJSXD8b0rCoM5am', 'workspace_5b07b5d0-c89d-48b1-96c8-dde3ddcfb282'],
    [
      'lazy sibling',
      'ses_fa35b5e6effek0OPk3NLj6q46v',
      'workspace_582c19e2-dfb1-4e89-b5e8-f41efa5b1fab',
    ],
  ])(
    'prepares captured %s public metadata without DB-only or lifecycle fields',
    async (_label, kiloId, cloudId) => {
      const metadata = {
        session_id: kiloId,
        cloud_agent_session_id: cloudId,
        cloud_agent_worktree_id: 'worktree_5b07b5d0-c89d-48b1-96c8-dde3ddcfb282',
        organization_id: null,
        created_on_platform: 'cloud-agent-web',
        runtimeState: {
          sessionId: cloudId,
          kiloSessionId: kiloId,
          userId: '[redacted]',
          mode: 'code',
          model: 'kilo/fake-deterministic',
          autoCommit: false,
          execution: null,
          version: 1,
        },
      };
      const api = fixture({ getSession: async () => metadata });
      const submission = await api.prepareReviewSubmission({
        destinationKiloSessionId: metadata.session_id,
        expectedWorktreeId: metadata.cloud_agent_worktree_id,
        prompt: 'Captured metadata verification',
      });
      expect(submission.destinationCloudAgentSessionId).toBe(cloudId);
      expect(submission.payload).toEqual({
        type: 'prompt',
        prompt: 'Captured metadata verification',
        mode: 'code',
        model: 'kilo/fake-deterministic',
        variant: undefined,
      });
      expect(api.send).not.toHaveBeenCalled();
      expect(api.getMessageResult).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['read-only', { cloud_agent_session_id: null }],
    ['non-browser', { created_on_platform: 'cloud-agent-mobile' }],
    ['legacy', { cloud_agent_session_id: 'agent_12345678-1234-4234-9234-123456789abc' }],
    ['wrong organization', { organization_id: organizationId }],
    ['different worktree', { cloud_agent_worktree_id: 'worktree_other' }],
    ['missing worktree', { cloud_agent_worktree_id: null }],
    ['missing runtime', { runtimeState: null }],
    ['wrong Kilo session', { session_id: 'ses_other' }],
    [
      'missing runtime Kilo session',
      { runtimeState: { sessionId: cloudAgentSessionId, mode: 'code', model: 'model' } },
    ],
    [
      'wrong runtime Kilo session',
      {
        runtimeState: {
          sessionId: cloudAgentSessionId,
          kiloSessionId: 'ses_other',
          mode: 'code',
          model: 'model',
        },
      },
    ],
    [
      'wrong runtime organization',
      {
        runtimeState: {
          sessionId: cloudAgentSessionId,
          kiloSessionId,
          orgId: organizationId,
          mode: 'code',
          model: 'model',
        },
      },
    ],
    ['wrong runtime', { runtimeState: { sessionId: 'workspace_other', kiloSessionId } }],
    [
      'missing model',
      { runtimeState: { sessionId: cloudAgentSessionId, kiloSessionId, mode: 'code' } },
    ],
    [
      'unknown agent',
      {
        runtimeState: {
          sessionId: cloudAgentSessionId,
          kiloSessionId,
          mode: 'other',
          model: 'model',
        },
      },
    ],
  ] satisfies Array<[string, Partial<Target>]>)(
    'rejects %s targets without a send',
    async (_name, change) => {
      const api = fixture({ getSession: async () => ({ ...target(), ...change }) });
      await expect(api.prepareReviewSubmission(input)).rejects.toThrow();
      expect(api.send).not.toHaveBeenCalled();
    }
  );

  it('rejects a personal target from an organization provider', async () => {
    const api = fixture({ organizationId });
    await expect(api.prepareReviewSubmission(input)).rejects.toThrow();
  });

  it('preserves authorization failure without returning raw diagnostics', async () => {
    const api = fixture({
      getSession: async () => {
        throw { data: { code: 'FORBIDDEN' }, message: 'private database diagnostic' };
      },
    });
    await expect(api.prepareReviewSubmission(input)).rejects.toThrow(
      'You are not authorized to use the Cloud Agent.'
    );
  });

  it.each(['', '  ', 'a'.repeat(100_001)])(
    'rejects empty or oversized feedback before metadata lookup',
    async prompt => {
      const api = fixture();
      await expect(api.prepareReviewSubmission({ ...input, prompt })).rejects.toThrow();
      expect(api.getSession).not.toHaveBeenCalled();
    }
  );
});

describe('worktree review admission and reconciliation', () => {
  it('shares one in-flight send for double clicks and caches acceptance', async () => {
    const sending = deferred<Awaited<ReturnType<Dependencies['send']>>>();
    const api = fixture();
    api.send.mockReturnValueOnce(sending.promise);
    const submission = await api.prepareReviewSubmission(input);
    const first = api.submitReview(submission);
    const second = api.submitReview(submission);
    expect(first).toBe(second);
    expect(api.send).toHaveBeenCalledTimes(1);
    sending.resolve({ cloudAgentSessionId, messageId: submission.messageId, delivery: 'queued' });
    expect(await first).toEqual({ status: 'accepted', delivery: 'queued' });
    expect(await api.submitReview(submission)).toEqual({ status: 'accepted', delivery: 'queued' });
    expect(api.send).toHaveBeenCalledTimes(1);
  });

  it.each(['queued', 'running', 'completed', 'failed', 'interrupted'] as const)(
    'reconciles lost acknowledgments for %s without a second admission',
    async status => {
      const api = fixture();
      const submission = await api.prepareReviewSubmission(input);
      api.send.mockRejectedValueOnce(new Error('private response-loss diagnostic'));
      api.getMessageResult.mockResolvedValueOnce(messageResult(submission, status));
      expect(await api.submitReview(submission)).toEqual({
        status: 'accepted',
        delivery: status === 'queued' ? 'queued' : 'sent',
      });
      await api.submitReview(submission);
      expect(api.send).toHaveBeenCalledTimes(1);
    }
  );

  it('reconciles terminal results before retrying an unknown outcome', async () => {
    const api = fixture();
    const submission = await api.prepareReviewSubmission(input);
    api.send.mockRejectedValueOnce(new Error('fetch failed'));
    api.getMessageResult.mockRejectedValueOnce(new Error('read unavailable'));
    expect((await api.submitReview(submission)).status).toBe('unknown');
    api.getMessageResult.mockResolvedValueOnce(messageResult(submission, 'completed'));
    expect(await api.submitReview(submission)).toEqual({ status: 'accepted', delivery: 'sent' });
    expect(api.send).toHaveBeenCalledTimes(1);
  });

  it('does not retry an unknown outcome until the exact result can be read', async () => {
    const api = fixture();
    const submission = await api.prepareReviewSubmission(input);
    api.send.mockRejectedValueOnce(new Error('response lost'));
    api.getMessageResult.mockRejectedValue(new Error('read unavailable'));
    expect((await api.submitReview(submission)).status).toBe('unknown');
    expect((await api.submitReview(submission)).status).toBe('unknown');
    expect(api.send).toHaveBeenCalledTimes(1);
  });

  it('retries an absent result with the same frozen ID, target, and payload only on explicit submit', async () => {
    const api = fixture();
    const submission = await api.prepareReviewSubmission(input);
    api.send.mockRejectedValueOnce(new Error('response lost'));
    expect((await api.submitReview(submission)).status).toBe('unknown');
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(await api.submitReview(submission)).toEqual({ status: 'accepted', delivery: 'sent' });
    expect(api.send.mock.calls).toEqual([[submission], [submission]]);
    expect(api.getMessageResult).toHaveBeenCalledTimes(2);
  });

  it('keeps a prior-unknown batch locked after an absent retry is refused until its original result arrives', async () => {
    const api = fixture();
    const submission = await api.prepareReviewSubmission(input);
    api.send.mockRejectedValueOnce(new Error('response lost'));
    expect((await api.submitReview(submission)).status).toBe('unknown');

    api.send.mockRejectedValueOnce({ data: { code: 'TOO_MANY_REQUESTS' } });
    api.getMessageResult.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    expect((await api.submitReview(submission)).status).toBe('unknown');
    expect(api.send.mock.calls).toEqual([[submission], [submission]]);

    api.getMessageResult.mockResolvedValueOnce(messageResult(submission, 'completed'));
    expect(await api.submitReview(submission)).toEqual({ status: 'accepted', delivery: 'sent' });
    expect(api.getSession).toHaveBeenCalledTimes(1);
    expect(api.send.mock.calls).toEqual([[submission], [submission]]);
    expect(api.getMessageResult.mock.calls).toEqual([
      [submission],
      [submission],
      [submission],
      [submission],
    ]);
  });

  it('treats a terminal race after the retry read as accepted rather than rejected', async () => {
    const api = fixture();
    const submission = await api.prepareReviewSubmission(input);
    api.send.mockRejectedValueOnce(new Error('response lost'));
    await api.submitReview(submission);
    api.send.mockRejectedValueOnce({ data: { code: 'CONFLICT' } });
    api.getMessageResult
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(messageResult(submission, 'failed'));
    expect(await api.submitReview(submission)).toEqual({ status: 'accepted', delivery: 'sent' });
  });

  it.each(['FORBIDDEN', 'PAYMENT_REQUIRED', 'BAD_REQUEST', 'PRECONDITION_FAILED'])(
    'returns a sanitized rejection for %s when not admitted',
    async code => {
      const api = fixture();
      const submission = await api.prepareReviewSubmission(input);
      api.send.mockRejectedValueOnce({ data: { code }, message: 'private credentials diagnostic' });
      const result = await api.submitReview(submission);
      expect(result.status).toBe('rejected');
      expect(JSON.stringify(result)).not.toContain('private');
      expect(submission.payload.prompt).toBe(input.prompt);
    }
  );

  it('does not claim rejection when prior admission remains unknown and access was removed', async () => {
    const api = fixture();
    const submission = await api.prepareReviewSubmission(input);
    api.send.mockRejectedValueOnce(new Error('response lost'));
    await api.submitReview(submission);
    api.getMessageResult.mockRejectedValueOnce({ data: { code: 'FORBIDDEN' } });
    expect((await api.submitReview(submission)).status).toBe('unknown');
    expect(api.send).toHaveBeenCalledTimes(1);
  });

  it('rejects copied or unprepared submissions rather than accepting altered payloads', async () => {
    const api = fixture();
    const submission = await api.prepareReviewSubmission(input);
    expect(
      (
        await api.submitReview({
          ...submission,
          payload: { ...submission.payload, prompt: 'changed' },
        })
      ).status
    ).toBe('rejected');
    expect(api.send).not.toHaveBeenCalled();
  });

  it('does not accept an acknowledgment or result for a different message', async () => {
    const api = fixture();
    const submission = await api.prepareReviewSubmission(input);
    api.send.mockResolvedValueOnce({
      cloudAgentSessionId,
      messageId: 'msg_other',
      delivery: 'sent',
    });
    api.getMessageResult.mockResolvedValueOnce({
      ...messageResult(submission, 'completed'),
      messageId: 'msg_other',
    });
    expect((await api.submitReview(submission)).status).toBe('unknown');
  });
});
