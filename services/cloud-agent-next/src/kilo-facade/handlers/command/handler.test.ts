import type { SessionCommandResponse } from '@kilocode/sdk/v2';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { preflightExistingPromptModelMock } = vi.hoisted(() => ({
  preflightExistingPromptModelMock: vi.fn(),
}));

vi.mock('../../../session/model-preflight.js', () => ({
  preflightExistingPromptModel: preflightExistingPromptModelMock,
}));

import type { OwnedRootHandlerContext } from '../../contracts.js';
import { publicCloudAgentDirectory } from '../../public-sdk-projection.js';
import { handleCommand } from './handler.js';

const kiloSessionId = 'ses_12345678901234567890123456';
const cloudAgentSessionId = 'agent_command';
const messageId = 'msg_018f1e2d3c4bCommandFacadeA';

function commandContext(params: {
  body?: unknown;
  rawBody?: string;
  search?: string;
  authToken?: string | null;
  headers?: Record<string, string>;
  admission?: unknown;
}) {
  const directory = encodeURIComponent(publicCloudAgentDirectory(kiloSessionId));
  const request = new Request(
    `https://facade.test/kilo/session/${kiloSessionId}/command${params.search ?? `?directory=${directory}`}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...params.headers },
      body: params.rawBody ?? JSON.stringify(params.body ?? { command: 'init', arguments: '' }),
    }
  );
  const admitCommand = vi.fn().mockResolvedValue(
    params.admission ?? {
      success: true,
      outcome: 'queued',
      messageId,
      compatibilityDelivery: 'queued',
    }
  );
  const validateCommandBalance = vi.fn().mockResolvedValue({ success: true });
  const hasMessageAdmission = vi.fn().mockResolvedValue(false);
  const context: OwnedRootHandlerContext = {
    request,
    env: {
      CLOUD_AGENT_SESSION: {
        idFromName: vi.fn(() => 'session-do-id'),
        get: vi.fn(() => ({ hasMessageAdmission })),
      },
    } as unknown as OwnedRootHandlerContext['env'],
    userId: 'user-1',
    authToken: params.authToken === null ? undefined : (params.authToken ?? 'validated-token'),
    url: new URL(request.url),
    kiloPath: `/session/${kiloSessionId}/command`,
    kiloSessionId,
    encodedKiloSessionId: kiloSessionId,
    cloudAgentSessionId,
    deps: { admitCommand, validateCommandBalance },
  };
  return { context, admitCommand, validateCommandBalance, hasMessageAdmission };
}

describe('command handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    preflightExistingPromptModelMock.mockResolvedValue(undefined);
  });

  it('durably admits a command and returns an immediate synthetic acknowledgement', async () => {
    const { context, admitCommand } = commandContext({
      body: {
        messageID: messageId,
        command: 'review/security',
        arguments: '  --strict  ',
        agent: 'plan',
        model: 'kilo/anthropic/claude-sonnet-4',
        variant: 'high',
        snapshotInitialization: 'wait',
        parts: [],
      },
    });

    const response = await handleCommand(context);
    const body = (await response.json()) as SessionCommandResponse;

    expect(response.status).toBe(200);
    expect(admitCommand).toHaveBeenCalledWith({
      env: context.env,
      userId: 'user-1',
      cloudAgentSessionId,
      request: {
        userId: 'user-1',
        turn: {
          type: 'command',
          id: messageId,
          command: 'review/security',
          arguments: '  --strict  ',
          snapshotInitialization: 'wait',
        },
        agent: {
          mode: 'plan',
          model: 'anthropic/claude-sonnet-4',
          variant: 'high',
        },
      },
    });
    expect(preflightExistingPromptModelMock).toHaveBeenCalledWith({
      env: context.env,
      userId: 'user-1',
      cloudAgentSessionId,
      requestedModel: 'anthropic/claude-sonnet-4',
      procedure: 'kilo.session.command',
    });
    expect(body).toMatchObject({
      info: {
        sessionID: kiloSessionId,
        role: 'assistant',
        parentID: messageId,
        modelID: 'anthropic/claude-sonnet-4',
        providerID: 'kilo',
        mode: 'plan',
        agent: 'plan',
        variant: 'high',
        path: {
          cwd: publicCloudAgentDirectory(kiloSessionId),
          root: publicCloudAgentDirectory(kiloSessionId),
        },
        cost: 0,
      },
      parts: [],
    });
    expect(body.info.id).not.toBe(messageId);
    expect(body.info.time).not.toHaveProperty('completed');
    expect(body.info).not.toHaveProperty('finish');
  });

  it.each([
    ['', 'KILO_SESSION_SELECTOR_UNSUPPORTED'],
    ['?workspace=/private/workspace', 'KILO_SESSION_SELECTOR_UNSUPPORTED'],
    [
      `?directory=${encodeURIComponent(publicCloudAgentDirectory('ses_22222222222222222222222222'))}`,
      'KILO_SESSION_SELECTOR_UNSUPPORTED',
    ],
    [
      `?directory=${encodeURIComponent(publicCloudAgentDirectory(kiloSessionId))}&directory=${encodeURIComponent(publicCloudAgentDirectory(kiloSessionId))}`,
      'KILO_QUERY_INVALID',
    ],
  ])(
    'rejects missing or unsupported selectors before mutation side effects',
    async (search, code) => {
      const { context, admitCommand, validateCommandBalance } = commandContext({ search });

      const response = await handleCommand(context);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: code });
      expect(validateCommandBalance).not.toHaveBeenCalled();
      expect(admitCommand).not.toHaveBeenCalled();
    }
  );

  it('rejects non-empty command parts explicitly before mutation side effects', async () => {
    const { context, admitCommand, validateCommandBalance } = commandContext({
      body: {
        command: 'init',
        arguments: '',
        parts: [{ type: 'file', mime: 'text/plain', url: 'file:///tmp/a.txt' }],
      },
    });

    const response = await handleCommand(context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'KILO_COMMAND_PARTS_UNSUPPORTED',
      message: 'File attachments are not supported for public Kilo commands',
    });
    expect(validateCommandBalance).not.toHaveBeenCalled();
    expect(admitCommand).not.toHaveBeenCalled();
  });

  it.each([
    { rawBody: '{' },
    { body: { command: 'init', arguments: '', unknown: true } },
    { body: { command: 'init', arguments: '', model: 'anthropic/claude' } },
    {
      body: { command: 'init', arguments: '' },
      headers: { 'content-length': String(256 * 1024 + 1) },
    },
  ])('rejects invalid command bodies before mutation side effects', async params => {
    const { context, admitCommand, validateCommandBalance } = commandContext(params);

    const response = await handleCommand(context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'KILO_COMMAND_BODY_INVALID' });
    expect(validateCommandBalance).not.toHaveBeenCalled();
    expect(admitCommand).not.toHaveBeenCalled();
  });

  it('requires facade authentication and rejects balance bypass', async () => {
    const missingAuth = commandContext({ authToken: null });
    const missingAuthResponse = await handleCommand(missingAuth.context);
    expect(missingAuthResponse.status).toBe(500);
    await expect(missingAuthResponse.json()).resolves.toMatchObject({
      error: 'KILO_FACADE_UNAVAILABLE',
    });

    const bypass = commandContext({ headers: { 'x-skip-balance-check': 'true' } });
    const bypassResponse = await handleCommand(bypass.context);
    expect(bypassResponse.status).toBe(400);
    await expect(bypassResponse.json()).resolves.toMatchObject({
      error: 'KILO_BALANCE_BYPASS_UNSUPPORTED',
    });
    expect(bypass.validateCommandBalance).not.toHaveBeenCalled();
    expect(bypass.admitCommand).not.toHaveBeenCalled();
  });

  it('preserves balance validation failure status and prevents admission', async () => {
    const { context, validateCommandBalance, admitCommand } = commandContext({});
    validateCommandBalance.mockResolvedValue({
      success: false,
      status: 402,
      message: 'Insufficient credits',
    });

    const response = await handleCommand(context);

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual({
      error: 'KILO_BALANCE_VALIDATION_FAILED',
      message: 'Insufficient credits',
    });
    expect(admitCommand).not.toHaveBeenCalled();
  });

  it('uses the admitted generated message identity as the acknowledgement parent', async () => {
    const generatedMessageId = 'msg_018f1e2d3c4bGeneratedCmdAB';
    const { context } = commandContext({
      body: { command: 'init', arguments: '' },
      admission: {
        success: true,
        outcome: 'queued',
        messageId: generatedMessageId,
        compatibilityDelivery: 'queued',
      },
    });

    const response = await handleCommand(context);

    await expect(response.json()).resolves.toMatchObject({
      info: { parentID: generatedMessageId, modelID: 'unknown', agent: 'unknown' },
    });
  });

  it('skips model preflight for an idempotently replayed durable command', async () => {
    const { context, hasMessageAdmission, admitCommand } = commandContext({
      body: { messageID: messageId, command: 'init', arguments: '' },
    });
    hasMessageAdmission.mockResolvedValue(true);
    preflightExistingPromptModelMock.mockRejectedValue(new Error('model is unavailable'));

    const response = await handleCommand(context);

    expect(response.status).toBe(200);
    expect(preflightExistingPromptModelMock).not.toHaveBeenCalled();
    expect(admitCommand).toHaveBeenCalledOnce();
  });

  it.each([
    [
      new TRPCError({ code: 'BAD_REQUEST', message: 'private invalid model details' }),
      400,
      'KILO_COMMAND_ADMISSION_REJECTED',
      'Kilo command model selection is not available',
    ],
    [
      new TRPCError({ code: 'FORBIDDEN', message: 'private authorization details' }),
      403,
      'KILO_COMMAND_ADMISSION_REJECTED',
      'Kilo command model selection is not available',
    ],
    [
      new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'private provider details' }),
      503,
      'MODEL_VALIDATION_UNAVAILABLE',
      'Command model validation is temporarily unavailable',
    ],
    [
      new TRPCError({ code: 'NOT_FOUND', message: 'private session details' }),
      404,
      'KILO_SESSION_NOT_FOUND',
      'Cloud Agent root Kilo session was not found',
    ],
    [
      new Error('private unexpected preflight details'),
      500,
      'KILO_COMMAND_ADMISSION_FAILED',
      'Kilo command admission failed',
    ],
  ])('maps model preflight failures without admission', async (error, status, code, message) => {
    const { context, admitCommand } = commandContext({});
    preflightExistingPromptModelMock.mockRejectedValue(error);

    const response = await handleCommand(context);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: code, message });
    expect(admitCommand).not.toHaveBeenCalled();
  });

  it.each([
    [
      { success: false, code: 'BAD_REQUEST', error: 'invalid intent' },
      400,
      'KILO_COMMAND_ADMISSION_REJECTED',
      'Kilo command admission was rejected',
    ],
    [
      { success: false, code: 'NOT_FOUND', error: 'missing' },
      404,
      'KILO_SESSION_NOT_FOUND',
      'Cloud Agent root Kilo session was not found',
    ],
    [
      { success: false, code: 'PENDING_QUEUE_FULL', error: 'full' },
      429,
      'KILO_COMMAND_QUEUE_FULL',
      'Kilo command queue is full',
    ],
    [
      { success: false, code: 'WORKSPACE_SETUP_FAILED', error: 'retry' },
      503,
      'WORKSPACE_SETUP_FAILED',
      'Kilo command runtime is temporarily unavailable',
    ],
    [
      { success: false, code: 'INTERNAL', error: 'private details' },
      500,
      'KILO_COMMAND_ADMISSION_FAILED',
      'Kilo command admission failed',
    ],
  ])('maps durable admission failures', async (admission, status, code, message) => {
    const { context } = commandContext({ admission });

    const response = await handleCommand(context);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: code, message });
  });

  it('sanitizes unexpected durable admission failures', async () => {
    const { context, admitCommand } = commandContext({});
    admitCommand.mockRejectedValue(new Error('private durable object details'));

    const response = await handleCommand(context);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'KILO_COMMAND_ADMISSION_FAILED',
      message: 'Kilo command admission failed',
    });
  });
});
