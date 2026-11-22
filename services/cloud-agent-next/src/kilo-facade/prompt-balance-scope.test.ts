import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BalanceValidationModule from '../balance-validation.js';
import type * as ModelPreflightModule from '../session/model-preflight.js';
import type * as SessionAccessModule from '../session-access.js';
import type * as LoggerModule from '../logger.js';
import type { DurableAdmissionAck } from '../execution/types.js';
import type { KiloFacadeRequestDeps } from './user-kilo-facade.js';
import type { Env } from '../types';

const {
  requireCurrentSessionAccessMock,
  validateBalanceOnlyMock,
  preflightSessionRuntimeMock,
  preflightExistingPromptModelMock,
  loggerWarnMock,
  loggerWithFieldsMock,
} = vi.hoisted(() => ({
  requireCurrentSessionAccessMock: vi.fn(),
  validateBalanceOnlyMock: vi.fn(),
  preflightSessionRuntimeMock: vi.fn(),
  preflightExistingPromptModelMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerWithFieldsMock: vi.fn(),
}));

vi.mock('../logger.js', async importOriginal => {
  const logger = {
    withFields: loggerWithFieldsMock,
    warn: loggerWarnMock,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
    setTags: vi.fn(),
    getTags: vi.fn(() => ({})),
  };
  loggerWithFieldsMock.mockReturnValue(logger);
  return {
    ...(await importOriginal<typeof LoggerModule>()),
    logger,
  };
});

vi.mock('../session-access.js', async importOriginal => ({
  ...(await importOriginal<typeof SessionAccessModule>()),
  requireCurrentSessionAccess: requireCurrentSessionAccessMock,
}));

vi.mock('../balance-validation.js', async importOriginal => ({
  ...(await importOriginal<typeof BalanceValidationModule>()),
  validateBalanceOnly: validateBalanceOnlyMock,
}));

vi.mock('../session/model-preflight.js', async importOriginal => ({
  ...(await importOriginal<typeof ModelPreflightModule>()),
  preflightSessionRuntime: preflightSessionRuntimeMock,
  preflightExistingPromptModel: preflightExistingPromptModelMock,
}));

vi.mock('../db/pg.js', () => ({
  getPgDb: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    ctx: unknown;
    env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { handleKiloFacadeRequest } = await import('./user-kilo-facade.js');
const { validateBalanceOnly } = await import('../balance-validation.js');
const { requireCurrentSessionAccess } = await import('../session-access.js');

const kiloSessionId = 'ses_12345678901234567890123456';
const workspaceSessionId = 'workspace_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function envStub(): Env {
  return {
    SESSION_INGEST: {
      resolveCloudAgentRootSessionForKiloSession: vi.fn(),
      getCloudAgentRootSessionSnapshot: vi.fn(),
      listCloudAgentRootSessions: vi.fn(),
      getCloudAgentRootSessionMessages: vi.fn(),
    },
    SANDBOX_SESSION: {
      idFromName: vi.fn(() => 'sandbox-session-do-id'),
      get: vi.fn(),
    },
  } as unknown as Env;
}

/** Sends one facade mutation with the live default payer-balance seam. */
function postMutation(params: {
  env: Env;
  path: 'prompt_async' | 'command';
  body: unknown;
  admitPrompt?: KiloFacadeRequestDeps['admitPrompt'];
}) {
  const deps: KiloFacadeRequestDeps = {
    resolveRootSessionForKiloSession: vi.fn(async () => ({
      cloudAgentSessionId: workspaceSessionId,
    })),
    ...(params.admitPrompt === undefined ? {} : { admitPrompt: params.admitPrompt }),
  };
  return handleKiloFacadeRequest({
    request: new Request(`http://worker.test/kilo/session/${kiloSessionId}/${params.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params.body),
    }),
    env: params.env,
    userId: 'usr_1',
    authToken: 'validated-token',
    deps,
  });
}

const PROMPT_BODY = { parts: [{ type: 'text', text: 'hello' }] };
const COMMAND_BODY = { command: 'compact' };
const QUEUED_ADMISSION: DurableAdmissionAck = {
  success: true,
  outcome: 'queued',
  compatibilityDelivery: 'queued',
  messageId: 'msg_018f1e2d3c4bPayerScopeAbCdEf',
};

describe('prompt payer scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireCurrentSessionAccessMock.mockResolvedValue({
      kiloSessionId,
      organizationId: 'org-funded',
    });
    validateBalanceOnlyMock.mockResolvedValue({ success: true });
    preflightSessionRuntimeMock.mockResolvedValue(undefined);
    preflightExistingPromptModelMock.mockResolvedValue(undefined);
  });

  it('checks the balance against the organization that owns the session', async () => {
    const env = envStub();
    const admitPrompt = vi.fn().mockResolvedValue(QUEUED_ADMISSION);

    const response = await postMutation({
      env,
      path: 'prompt_async',
      body: PROMPT_BODY,
      admitPrompt,
    });

    expect(response.status).toBe(204);
    expect(requireCurrentSessionAccess).toHaveBeenCalledWith({
      env,
      kiloUserId: 'usr_1',
      cloudAgentSessionId: workspaceSessionId,
    });
    expect(validateBalanceOnly).toHaveBeenCalledWith('validated-token', 'org-funded', env);
    expect(admitPrompt).toHaveBeenCalledOnce();
  });

  it('checks the balance against the personal account when the session has no organization', async () => {
    const env = envStub();
    const admitPrompt = vi.fn().mockResolvedValue(QUEUED_ADMISSION);
    requireCurrentSessionAccessMock.mockResolvedValue({
      kiloSessionId,
      organizationId: null,
    });

    const response = await postMutation({
      env,
      path: 'prompt_async',
      body: PROMPT_BODY,
      admitPrompt,
    });

    expect(response.status).toBe(204);
    expect(validateBalanceOnly).toHaveBeenCalledWith('validated-token', undefined, env);
    expect(admitPrompt).toHaveBeenCalledOnce();
  });

  it('answers a retryable failure when the payer scope cannot be read', async () => {
    const env = envStub();
    const admitPrompt = vi.fn();
    requireCurrentSessionAccessMock.mockRejectedValue(
      new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Session access is temporarily unavailable',
      })
    );

    const response = await postMutation({
      env,
      path: 'prompt_async',
      body: PROMPT_BODY,
      admitPrompt,
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('1');
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_BALANCE_VALIDATION_FAILED',
    });
    expect(validateBalanceOnly).not.toHaveBeenCalled();
    expect(admitPrompt).not.toHaveBeenCalled();
  });

  it('hides a payer scope the caller cannot reach as a missing root session', async () => {
    const env = envStub();
    const admitPrompt = vi.fn();
    requireCurrentSessionAccessMock.mockRejectedValue(
      new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' })
    );

    const response = await postMutation({
      env,
      path: 'prompt_async',
      body: PROMPT_BODY,
      admitPrompt,
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_SESSION_NOT_FOUND',
    });
    expect(validateBalanceOnly).not.toHaveBeenCalled();
    expect(admitPrompt).not.toHaveBeenCalled();
  });

  it('keeps an insufficient credit answer without admitting the prompt', async () => {
    const env = envStub();
    const admitPrompt = vi.fn();
    validateBalanceOnlyMock.mockResolvedValue({
      success: false,
      status: 402,
      message: 'Insufficient credits: $1 minimum required',
    });

    const response = await postMutation({
      env,
      path: 'prompt_async',
      body: PROMPT_BODY,
      admitPrompt,
    });

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_BALANCE_VALIDATION_FAILED',
    });
    expect(admitPrompt).not.toHaveBeenCalled();
  });

  it('checks the organization payer before admitting a command turn', async () => {
    const env = envStub();
    const admitPrompt = vi.fn().mockResolvedValue(QUEUED_ADMISSION);

    const response = await postMutation({
      env,
      path: 'command',
      body: COMMAND_BODY,
      admitPrompt,
    });

    expect(response.status).toBe(204);
    expect(validateBalanceOnly).toHaveBeenCalledWith('validated-token', 'org-funded', env);
    expect(admitPrompt).toHaveBeenCalledOnce();
  });

  it('answers a retryable command failure when the payer scope cannot be read', async () => {
    const env = envStub();
    const admitPrompt = vi.fn();
    requireCurrentSessionAccessMock.mockRejectedValue(
      new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Session access is temporarily unavailable',
      })
    );

    const response = await postMutation({
      env,
      path: 'command',
      body: COMMAND_BODY,
      admitPrompt,
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('1');
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_BALANCE_VALIDATION_FAILED',
    });
    expect(validateBalanceOnly).not.toHaveBeenCalled();
    expect(admitPrompt).not.toHaveBeenCalled();
  });

  it('hides a command payer scope the caller cannot reach as a missing root session', async () => {
    const env = envStub();
    const admitPrompt = vi.fn();
    requireCurrentSessionAccessMock.mockRejectedValue(
      new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' })
    );

    const response = await postMutation({
      env,
      path: 'command',
      body: COMMAND_BODY,
      admitPrompt,
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_SESSION_NOT_FOUND',
    });
    expect(validateBalanceOnly).not.toHaveBeenCalled();
    expect(admitPrompt).not.toHaveBeenCalled();
  });

  it('repeats one failed payer read and then admits against the resolved payer', async () => {
    const env = envStub();
    const admitPrompt = vi.fn().mockResolvedValue(QUEUED_ADMISSION);
    requireCurrentSessionAccessMock
      .mockRejectedValueOnce(
        new TRPCError({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Session access is temporarily unavailable',
          cause: new Error('connect ECONNREFUSED'),
        })
      )
      .mockResolvedValue({ kiloSessionId, organizationId: 'org-funded' });

    const response = await postMutation({
      env,
      path: 'prompt_async',
      body: PROMPT_BODY,
      admitPrompt,
    });

    expect(response.status).toBe(204);
    expect(requireCurrentSessionAccess).toHaveBeenCalledTimes(2);
    expect(validateBalanceOnly).toHaveBeenCalledWith('validated-token', 'org-funded', env);
    expect(admitPrompt).toHaveBeenCalledOnce();
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it('reports once and admits nothing when the payer read fails on every attempt', async () => {
    const env = envStub();
    const admitPrompt = vi.fn();
    requireCurrentSessionAccessMock.mockRejectedValue(
      new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Session access is temporarily unavailable',
        cause: new Error('connect ECONNREFUSED 10.0.0.1:5432'),
      })
    );

    const response = await postMutation({
      env,
      path: 'prompt_async',
      body: PROMPT_BODY,
      admitPrompt,
    });

    expect(response.status).toBe(503);
    expect(requireCurrentSessionAccess).toHaveBeenCalledTimes(2);
    expect(validateBalanceOnly).not.toHaveBeenCalled();
    expect(admitPrompt).not.toHaveBeenCalled();
    expect(loggerWithFieldsMock).toHaveBeenCalledOnce();
    expect(loggerWithFieldsMock).toHaveBeenCalledWith({
      cloudAgentSessionId: workspaceSessionId,
      userId: 'usr_1',
      error: 'Error: connect ECONNREFUSED 10.0.0.1:5432',
    });
    expect(loggerWarnMock).toHaveBeenCalledOnce();
    expect(loggerWarnMock).toHaveBeenCalledWith('Prompt payer scope read failed');
  });

  it('reports a slow payer read failure without repeating it', async () => {
    // Only the clock is faked: the request path still awaits real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const env = envStub();
      const admitPrompt = vi.fn();
      requireCurrentSessionAccessMock.mockImplementation(async () => {
        // Past the slow-failure threshold: the pool's connect timeout is already
        // spent, so a repeat would only lengthen the wait before the answer.
        vi.advanceTimersByTime(1_050);
        throw new TRPCError({
          code: 'SERVICE_UNAVAILABLE',
          message: 'Session access is temporarily unavailable',
          cause: new Error('Connection terminated due to connection timeout'),
        });
      });

      const response = await postMutation({
        env,
        path: 'prompt_async',
        body: PROMPT_BODY,
        admitPrompt,
      });

      expect(response.status).toBe(503);
      expect(requireCurrentSessionAccess).toHaveBeenCalledOnce();
      expect(validateBalanceOnly).not.toHaveBeenCalled();
      expect(admitPrompt).not.toHaveBeenCalled();
      expect(loggerWarnMock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not repeat a denied payer scope and records nothing', async () => {
    const env = envStub();
    const admitPrompt = vi.fn();
    requireCurrentSessionAccessMock.mockRejectedValue(
      new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' })
    );

    const response = await postMutation({
      env,
      path: 'prompt_async',
      body: PROMPT_BODY,
      admitPrompt,
    });

    expect(response.status).toBe(404);
    expect(requireCurrentSessionAccess).toHaveBeenCalledOnce();
    expect(loggerWithFieldsMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });
});
