import { describe, expect, it } from '@jest/globals';
import {
  baseCreateWorktreeChatNextOutputSchema,
  baseCreateWorktreeChatNextSchema,
  baseGetSandboxStatusNextOutputSchema,
  baseGetSandboxStatusNextSchema,
  basePrepareSessionNextSchema,
  baseCancelQueuedMessageNextSchema,
  SANDBOX_STATUS_DETAIL_MESSAGES,
  type SandboxStatusSnapshot,
  baseWorktreeChangesNextSchema,
  baseWorktreeFileNextSchema,
  cloudAgentGetAttachmentDownloadUrlSchema,
  cloudAgentGetAttachmentUploadUrlSchema,
  cloudAgentRelaxedAttachmentFilenameSchema,
} from './cloud-agent-next-schemas';

const MESSAGE_UUID = '12345678-1234-4234-9234-123456789abc';
const ATTACHMENT_ID = '87654321-4321-4321-8321-cba987654321';
const KILO_SESSION_ID = 'ses_12345678901234567890123456';

const sandboxSnapshot = {
  status: 'active',
  provider: 'Cloudflare',
  observedAt: 1_800_000_000_000,
  detailCode: 'sandbox_ready',
  inactivityTimeoutMs: 300_000,
  estimatedSleepAt: null,
} satisfies SandboxStatusSnapshot;

const sandboxLifecycleCases = [
  { status: 'active', detailCode: 'sandbox_ready' },
  { status: 'sleeping', detailCode: 'sandbox_stopped' },
  { status: 'starting', detailCode: 'sandbox_starting' },
  { status: 'stopping', detailCode: 'sandbox_stopping' },
  { status: 'error', detailCode: 'sandbox_failed' },
  { status: 'unreachable', detailCode: 'connection_unavailable' },
  { status: 'unknown', detailCode: 'insufficient_evidence' },
  { status: 'unknown', detailCode: 'status_unavailable' },
] satisfies Pick<SandboxStatusSnapshot, 'status' | 'detailCode'>[];

describe('baseGetSandboxStatusNextOutputSchema', () => {
  it.each(sandboxLifecycleCases)('accepts $status with $detailCode', lifecycle => {
    for (const provider of ['Cloudflare', 'Vercel', 'Unknown']) {
      const response = { ...sandboxSnapshot, ...lifecycle, provider };
      expect(baseGetSandboxStatusNextOutputSchema.parse(response)).toEqual(response);
    }
  });

  it('strips runtime identity, infrastructure, credentials, and raw errors before serialization', () => {
    const response = baseGetSandboxStatusNextOutputSchema.parse({
      ...sandboxSnapshot,
      cloudAgentSessionId: 'agent_private-session',
      sandboxId: 'usr-private-sandbox',
      providerInstanceId: 'private-instance',
      wrapperRunId: 'private-wrapper',
      region: 'private-region',
      url: 'https://private-runtime.invalid',
      credentials: { token: 'private-credential' },
      headers: { Authorization: 'Bearer private-credential' },
      error: { message: 'private-provider-error', stack: 'private-stack' },
      message: 'private-provider-error',
    });
    expect(response).toStrictEqual(sandboxSnapshot);
    expect(JSON.stringify(response)).not.toContain('private');
  });

  it.each(['status', 'provider', 'detailCode'] as const)('rejects arbitrary text in %s', field => {
    expect(
      baseGetSandboxStatusNextOutputSchema.safeParse({
        ...sandboxSnapshot,
        [field]: 'private-provider-error',
      }).success
    ).toBe(false);
  });

  it('does not interpret loading as an authoritative starting state', () => {
    expect(
      baseGetSandboxStatusNextOutputSchema.safeParse({
        ...sandboxSnapshot,
        status: 'loading',
        detailCode: 'sandbox_starting',
      }).success
    ).toBe(false);
  });

  it('keeps an observation outage unknown, with distinct safe copy from sandbox failure', () => {
    const response = baseGetSandboxStatusNextOutputSchema.parse({
      ...sandboxSnapshot,
      status: 'unknown',
      detailCode: 'status_unavailable',
      inactivityTimeoutMs: null,
    });
    expect(SANDBOX_STATUS_DETAIL_MESSAGES[response.detailCode]).toBe(
      'Sandbox status is temporarily unavailable. This does not mean the sandbox failed.'
    );
    expect(
      baseGetSandboxStatusNextOutputSchema.safeParse({ ...response, status: 'error' }).success
    ).toBe(false);
    expect(SANDBOX_STATUS_DETAIL_MESSAGES.sandbox_failed).not.toBe(
      SANDBOX_STATUS_DETAIL_MESSAGES[response.detailCode]
    );
  });

  it.each(['observedAt', 'inactivityTimeoutMs', 'estimatedSleepAt'] as const)(
    'rejects invalid numeric values in %s',
    field => {
      for (const value of [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '123']) {
        expect(
          baseGetSandboxStatusNextOutputSchema.safeParse({ ...sandboxSnapshot, [field]: value })
            .success
        ).toBe(false);
      }
    }
  );

  it('requires a positive inactivity timeout when present', () => {
    expect(
      baseGetSandboxStatusNextOutputSchema.safeParse({ ...sandboxSnapshot, inactivityTimeoutMs: 0 })
        .success
    ).toBe(false);
  });

  it('allows null timing but not omitted timing fields', () => {
    const response = { ...sandboxSnapshot, inactivityTimeoutMs: null };
    expect(baseGetSandboxStatusNextOutputSchema.parse(response)).toEqual(response);
    for (const field of ['inactivityTimeoutMs', 'estimatedSleepAt']) {
      expect(
        baseGetSandboxStatusNextOutputSchema.safeParse({ ...response, [field]: undefined }).success
      ).toBe(false);
    }
  });

  it('preserves a supported future approximate estimate', () => {
    const response = {
      ...sandboxSnapshot,
      estimatedSleepAt: sandboxSnapshot.observedAt + 60_000,
    };
    expect(baseGetSandboxStatusNextOutputSchema.parse(response)).toEqual(response);
  });

  it.each(sandboxLifecycleCases.filter(lifecycle => lifecycle.status !== 'active'))(
    'rejects an estimate for $status/$detailCode',
    lifecycle => {
      expect(
        baseGetSandboxStatusNextOutputSchema.safeParse({
          ...sandboxSnapshot,
          ...lifecycle,
          estimatedSleepAt: sandboxSnapshot.observedAt + 60_000,
        }).success
      ).toBe(false);
    }
  );

  it('rejects estimates that are expired or lack a supported policy', () => {
    for (const estimatedSleepAt of [sandboxSnapshot.observedAt - 1, sandboxSnapshot.observedAt]) {
      expect(
        baseGetSandboxStatusNextOutputSchema.safeParse({ ...sandboxSnapshot, estimatedSleepAt })
          .success
      ).toBe(false);
    }
    expect(
      baseGetSandboxStatusNextOutputSchema.safeParse({
        ...sandboxSnapshot,
        estimatedSleepAt: sandboxSnapshot.observedAt + 60_000,
        inactivityTimeoutMs: null,
      }).success
    ).toBe(false);
  });
});

describe('baseGetSandboxStatusNextSchema', () => {
  it('accepts a control-plane session reference without runtime overrides', () => {
    const input = { cloudAgentSessionId: `workspace_${MESSAGE_UUID}` };
    expect(baseGetSandboxStatusNextSchema.parse(input)).toEqual(input);
  });

  it.each([
    `agent_${MESSAGE_UUID}`,
    `sess_${MESSAGE_UUID}`,
    KILO_SESSION_ID,
    MESSAGE_UUID,
    'workspace_',
    'workspace_pending',
    `workspace_${MESSAGE_UUID} `,
    `workspace_${MESSAGE_UUID}\n`,
    ` workspace_${MESSAGE_UUID}`,
    'workspace_../../private',
    'workspace_zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz',
  ])('rejects legacy, unrelated, or malformed reference %s', cloudAgentSessionId => {
    expect(baseGetSandboxStatusNextSchema.safeParse({ cloudAgentSessionId }).success).toBe(false);
  });

  it.each([
    'provider',
    'sandboxId',
    'providerInstanceId',
    'userId',
    'orgId',
    'estimatedSleepAt',
    'inactivityTimeoutMs',
  ])('rejects caller-supplied %s', field => {
    expect(
      baseGetSandboxStatusNextSchema.safeParse({
        cloudAgentSessionId: `workspace_${MESSAGE_UUID}`,
        [field]: 'private-override',
      }).success
    ).toBe(false);
  });

  it('requires a nonempty session reference', () => {
    expect(baseGetSandboxStatusNextSchema.safeParse({}).success).toBe(false);
    expect(baseGetSandboxStatusNextSchema.safeParse({ cloudAgentSessionId: '' }).success).toBe(
      false
    );
  });
});

describe('baseWorktreeChangesNextSchema', () => {
  const cloudAgentSessionId = `workspace_${MESSAGE_UUID}`;

  it('accepts only a control-plane session ID', () => {
    expect(baseWorktreeChangesNextSchema.parse({ cloudAgentSessionId })).toEqual({
      cloudAgentSessionId,
    });
  });

  it.each([`agent_${MESSAGE_UUID}`, KILO_SESSION_ID, '', 'workspace_', 'workspace_not-a-uuid'])(
    'rejects legacy or malformed session ID %s',
    cloudAgentSessionId => {
      expect(baseWorktreeChangesNextSchema.safeParse({ cloudAgentSessionId }).success).toBe(false);
    }
  );

  it.each(['directory', 'baseRef', 'sandboxId', 'revision'])(
    'rejects client-controlled %s',
    field => {
      expect(
        baseWorktreeChangesNextSchema.safeParse({ cloudAgentSessionId, [field]: 'override' })
          .success
      ).toBe(false);
    }
  );
});

describe('baseWorktreeFileNextSchema', () => {
  const input = {
    cloudAgentSessionId: `workspace_${MESSAGE_UUID}`,
    path: 'src/odd\nfile.ts',
    expectedRevision: 12,
  };

  it('preserves the exact relative path and expected revision', () => {
    expect(baseWorktreeFileNextSchema.parse(input)).toEqual(input);
  });

  it.each([
    { path: '' },
    { path: '/absolute' },
    { path: '../outside' },
    { path: 'src/../outside' },
    { path: 'src/./file' },
    { path: 'src//file' },
    { path: 'src/\0file' },
    { path: 'a'.repeat(4097) },
    { expectedRevision: 0 },
    { expectedRevision: 1.5 },
    { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { expectedRevision: '12' },
    { cloudAgentSessionId: `agent_${MESSAGE_UUID}` },
    { directory: '/workspace' },
    { baseRef: 'HEAD' },
    { sandboxId: 'usr_other' },
    { organizationId: MESSAGE_UUID },
  ])('rejects invalid or expanded file queries', override => {
    expect(baseWorktreeFileNextSchema.safeParse({ ...input, ...override }).success).toBe(false);
  });
});

describe('cloudAgentGetAttachmentUploadUrlSchema', () => {
  it('preserves the legacy 9-MIME contract when extension is absent', () => {
    const result = cloudAgentGetAttachmentUploadUrlSchema.safeParse({
      messageUuid: MESSAGE_UUID,
      attachmentId: ATTACHMENT_ID,
      contentType: 'image/png',
      contentLength: 1024,
    });
    expect(result.success).toBe(true);
  });

  it('preserves the existing web-hook request shape (no extension field)', () => {
    const result = cloudAgentGetAttachmentUploadUrlSchema.parse({
      messageUuid: MESSAGE_UUID,
      attachmentId: ATTACHMENT_ID,
      contentType: 'text/markdown',
      contentLength: 4096,
    });
    expect(result.contentType).toBe('text/markdown');
    expect(result.extension).toBeUndefined();
  });

  it('accepts a relaxed contentType when extension is provided', () => {
    const result = cloudAgentGetAttachmentUploadUrlSchema.safeParse({
      messageUuid: MESSAGE_UUID,
      attachmentId: ATTACHMENT_ID,
      contentType: 'application/x-kilo-binary',
      contentLength: 4096,
      extension: 'kilo',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a malformed contentType even when extension is provided', () => {
    const result = cloudAgentGetAttachmentUploadUrlSchema.safeParse({
      messageUuid: MESSAGE_UUID,
      attachmentId: ATTACHMENT_ID,
      contentType: 'not a mime',
      contentLength: 4096,
      extension: 'kilo',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a contentType outside the legacy allow-list when extension is absent', () => {
    const result = cloudAgentGetAttachmentUploadUrlSchema.safeParse({
      messageUuid: MESSAGE_UUID,
      attachmentId: ATTACHMENT_ID,
      contentType: 'application/x-kilo-binary',
      contentLength: 4096,
    });
    expect(result.success).toBe(false);
  });

  it('rejects deny-listed extensions on the upload input', () => {
    for (const extension of ['exe', 'dll', 'msi', 'com', 'scr', 'apk', 'ipa', 'dmg', 'pkg']) {
      const result = cloudAgentGetAttachmentUploadUrlSchema.safeParse({
        messageUuid: MESSAGE_UUID,
        attachmentId: ATTACHMENT_ID,
        contentType: 'application/octet-stream',
        contentLength: 4096,
        extension,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const extensionIssues = result.error.issues.filter(issue => issue.path[0] === 'extension');
        expect(extensionIssues[0]?.message).toContain(extension);
      }
    }
  });

  it('rejects extensions that exceed the 16-character shape or include non-alphanumerics', () => {
    expect(
      cloudAgentGetAttachmentUploadUrlSchema.safeParse({
        messageUuid: MESSAGE_UUID,
        attachmentId: ATTACHMENT_ID,
        contentType: 'application/octet-stream',
        contentLength: 4096,
        extension: 'abcdefghijklmnopq',
      }).success
    ).toBe(false);
    expect(
      cloudAgentGetAttachmentUploadUrlSchema.safeParse({
        messageUuid: MESSAGE_UUID,
        attachmentId: ATTACHMENT_ID,
        contentType: 'application/octet-stream',
        contentLength: 4096,
        extension: 'tar.gz',
      }).success
    ).toBe(false);
  });

  it('preserves the 20 MB positive contentLength cap even with an extension', () => {
    const result = cloudAgentGetAttachmentUploadUrlSchema.safeParse({
      messageUuid: MESSAGE_UUID,
      attachmentId: ATTACHMENT_ID,
      contentType: 'application/octet-stream',
      contentLength: 20 * 1024 * 1024 + 1,
      extension: 'kilo',
    });
    expect(result.success).toBe(false);
  });
});

describe('cloudAgentRelaxedAttachmentFilenameSchema', () => {
  it('accepts any 1-16 char alphanumeric extension after the UUID prefix', () => {
    for (const filename of [
      `${ATTACHMENT_ID}.kilo`,
      `${ATTACHMENT_ID}.docx`,
      `${ATTACHMENT_ID}.tar`,
      `${ATTACHMENT_ID}.a`,
      `${ATTACHMENT_ID}.123`,
    ]) {
      expect(cloudAgentRelaxedAttachmentFilenameSchema.safeParse(filename).success).toBe(true);
    }
  });

  it('rejects filenames whose extension is in the deny-list', () => {
    for (const extension of ['exe', 'dll', 'msi', 'com', 'scr', 'apk', 'ipa', 'dmg', 'pkg']) {
      expect(
        cloudAgentRelaxedAttachmentFilenameSchema.safeParse(`${ATTACHMENT_ID}.${extension}`).success
      ).toBe(false);
    }
  });

  it('rejects filenames outside the UUID + 1-16 alphanumeric shape', () => {
    expect(cloudAgentRelaxedAttachmentFilenameSchema.safeParse('not-a-uuid.kilo').success).toBe(
      false
    );
    expect(cloudAgentRelaxedAttachmentFilenameSchema.safeParse(`${ATTACHMENT_ID}`).success).toBe(
      false
    );
    expect(
      cloudAgentRelaxedAttachmentFilenameSchema.safeParse(`${ATTACHMENT_ID}.abcdefghijklmnopq`)
        .success
    ).toBe(false);
  });
});

describe('cloudAgentGetAttachmentDownloadUrlSchema', () => {
  it('accepts a relaxed UUID.filename pair', () => {
    const result = cloudAgentGetAttachmentDownloadUrlSchema.safeParse({
      messageUuid: MESSAGE_UUID,
      filename: `${ATTACHMENT_ID}.kilo`,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a deny-listed extension on the download input', () => {
    const result = cloudAgentGetAttachmentDownloadUrlSchema.safeParse({
      messageUuid: MESSAGE_UUID,
      filename: `${ATTACHMENT_ID}.exe`,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unparseable filename', () => {
    const result = cloudAgentGetAttachmentDownloadUrlSchema.safeParse({
      messageUuid: MESSAGE_UUID,
      filename: 'not-a-uuid.exe',
    });
    expect(result.success).toBe(false);
  });
});

describe('basePrepareSessionNextSchema cloneFromKiloSessionId union', () => {
  const OPERATION_KEY = '12345678-1234-4234-9234-123456789abc';
  const cloneOnlyInput = {
    githubRepo: 'acme/repo',
    cloneFromKiloSessionId: KILO_SESSION_ID,
    autoInitiate: true,
    operationKey: OPERATION_KEY,
    mode: 'code',
    model: 'kilo/test-model',
  };

  it('accepts a clone-only input with no prompt', () => {
    const result = basePrepareSessionNextSchema.safeParse(cloneOnlyInput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cloneFromKiloSessionId).toBe(KILO_SESSION_ID);
      expect(result.data.prompt).toBeUndefined();
    }
  });

  it('rejects a clone-only input that also carries a prompt', () => {
    expect(
      basePrepareSessionNextSchema.safeParse({ ...cloneOnlyInput, prompt: 'Continue the clone' })
        .success
    ).toBe(false);
  });

  it('rejects a clone-only input that also carries initialMessageId', () => {
    expect(
      basePrepareSessionNextSchema.safeParse({
        ...cloneOnlyInput,
        initialMessageId: 'msg_12345678901212345678901234',
      }).success
    ).toBe(false);
  });

  it('rejects a clone-only input that also carries initialPayload', () => {
    expect(
      basePrepareSessionNextSchema.safeParse({
        ...cloneOnlyInput,
        initialPayload: { type: 'prompt', prompt: 'hi', mode: 'code', model: 'gpt-4' },
      }).success
    ).toBe(false);
  });

  it('rejects a clone-only input missing operationKey', () => {
    const { operationKey: _omitted, ...withoutOperationKey } = cloneOnlyInput;
    expect(basePrepareSessionNextSchema.safeParse(withoutOperationKey).success).toBe(false);
  });

  it('rejects a clone-only input with autoInitiate false', () => {
    expect(
      basePrepareSessionNextSchema.safeParse({ ...cloneOnlyInput, autoInitiate: false }).success
    ).toBe(false);
  });

  it('rejects a malformed cloneFromKiloSessionId', () => {
    expect(
      basePrepareSessionNextSchema.safeParse({
        ...cloneOnlyInput,
        cloneFromKiloSessionId: 'agent_invalid',
      }).success
    ).toBe(false);
  });

  it('accepts a non-clone input with required prompt and no cloneFromKiloSessionId', () => {
    const result = basePrepareSessionNextSchema.safeParse({
      githubRepo: 'acme/repo',
      prompt: 'Continue the clone',
      mode: 'code',
      model: 'kilo/test-model',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cloneFromKiloSessionId).toBeUndefined();
    }
  });

  it('accepts a non-clone input with an explicit undefined cloneFromKiloSessionId', () => {
    const result = basePrepareSessionNextSchema.safeParse({
      githubRepo: 'acme/repo',
      prompt: 'Continue the clone',
      mode: 'code',
      model: 'kilo/test-model',
      cloneFromKiloSessionId: undefined,
    });
    expect(result.success).toBe(true);
  });

  it('does not accept client provenance from public session preparation input', () => {
    const result = basePrepareSessionNextSchema.parse({
      githubRepo: 'acme/repo',
      prompt: 'Create a session',
      mode: 'code',
      model: 'kilo/test-model',
      clientProvenance: 'browser',
    });

    expect(result).not.toHaveProperty('clientProvenance');
  });
});

describe('createWorktreeChat schemas', () => {
  const operationKey = '12345678-1234-4234-9234-123456789abc';
  const workspaceId = `workspace_${operationKey}`;
  const worktreeId = `worktree_${operationKey}`;

  it('accepts only a canonical source session and operation UUID', () => {
    expect(
      baseCreateWorktreeChatNextSchema.parse({
        sourceKiloSessionId: KILO_SESSION_ID,
        operationKey,
      })
    ).toEqual({ sourceKiloSessionId: KILO_SESSION_ID, operationKey });

    for (const input of [
      { sourceKiloSessionId: 'agent_not_a_kilo_session', operationKey },
      { sourceKiloSessionId: KILO_SESSION_ID, operationKey: 'not-a-uuid' },
      { sourceKiloSessionId: KILO_SESSION_ID, operationKey, clientProvenance: 'browser' },
      {
        sourceKiloSessionId: KILO_SESSION_ID,
        operationKey,
        sourceCloudAgentSessionId: workspaceId,
      },
    ]) {
      expect(baseCreateWorktreeChatNextSchema.safeParse(input).success).toBe(false);
    }
  });

  it('requires canonical workspace/worktree output and rejects private runtime paths', () => {
    const output = {
      kiloSessionId: KILO_SESSION_ID,
      cloudAgentSessionId: workspaceId,
      worktreeId,
      replayed: true,
    };

    expect(baseCreateWorktreeChatNextOutputSchema.parse(output)).toEqual(output);

    for (const invalidOutput of [
      { ...output, cloudAgentSessionId: `agent_${operationKey}` },
      { ...output, worktreeId: 'worktree_../../private' },
      { ...output, workspacePath: '/private/shared-checkout' },
    ]) {
      expect(baseCreateWorktreeChatNextOutputSchema.safeParse(invalidOutput).success).toBe(false);
    }
  });
});

describe('baseCancelQueuedMessageNextSchema', () => {
  const VALID_MESSAGE_ID = 'msg_123456789abc123456789ABCDE';

  it('accepts a session id with a message id', () => {
    expect(
      baseCancelQueuedMessageNextSchema.safeParse({
        sessionId: 'agent_123',
        messageId: VALID_MESSAGE_ID,
      }).success
    ).toBe(true);
  });

  it('requires both sessionId and messageId', () => {
    expect(baseCancelQueuedMessageNextSchema.safeParse({ sessionId: 'agent_123' }).success).toBe(
      false
    );
    expect(
      baseCancelQueuedMessageNextSchema.safeParse({ messageId: VALID_MESSAGE_ID }).success
    ).toBe(false);
  });
});
