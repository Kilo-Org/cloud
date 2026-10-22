import { describe, expect, it, vi } from 'vitest';
import { parseSessionMetadata } from '../../persistence/session-metadata.js';
import type { ControlPlaneControlResult } from '../../shared/control-plane-protocol.js';
import {
  SANDBOX_STATUS_DETAIL_MESSAGES,
  type SandboxStatusSnapshot,
} from '../../shared/sandbox-status.js';
import { createControlPlaneTerminals } from './terminals.js';

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));

const SESSION_ID = 'workspace_11111111-1111-4111-8111-111111111111';
const SANDBOX_ID = 'ses-11111111111141118111111111111111';
const DIRECTORY = '/workspace/terminal';
const CURRENT_WRAPPER = 'wr_current';

function fakeStorage() {
  const values = new Map<string, unknown>();
  const storage = {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return structuredClone(values.get(key)) as T | undefined;
    },
    async put<T>(key: string, value: T): Promise<void> {
      values.set(key, structuredClone(value));
    },
    async delete(keys: string | string[]): Promise<void> {
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
    },
    async list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>> {
      const listed = new Map<string, T>();
      for (const [key, value] of values) {
        if (!options?.prefix || key.startsWith(options.prefix)) {
          listed.set(key, structuredClone(value) as T);
        }
      }
      return listed;
    },
  };
  return { storage, values };
}

function metadata() {
  return parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: {
      sessionId: SESSION_ID,
      userId: 'user_1',
      createdOnPlatform: 'cloud-agent-web',
    },
    auth: { kiloSessionId: 'kilo_session_1' },
    agent: { mode: 'code', model: 'test-model' },
    workspace: { sandboxId: SANDBOX_ID, sandboxProvider: 'cloudflare' },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

function pty(id: string) {
  return {
    id,
    title: 'Terminal',
    command: '/bin/sh',
    args: [],
    cwd: DIRECTORY,
    status: 'running' as const,
    pid: 1,
  };
}

function sandboxStatus(status: 'active' | 'sleeping'): SandboxStatusSnapshot {
  return {
    status,
    provider: 'Cloudflare',
    observedAt: 1,
    detailCode: status === 'sleeping' ? 'sandbox_stopped' : 'sandbox_ready',
    inactivityTimeoutMs: 600_000,
    estimatedSleepAt: null,
  };
}

function record(wrapperId: string, ptyId: string) {
  return {
    ptyId,
    ownerId: 'user_1',
    sessionId: SESSION_ID,
    kiloSessionId: 'kilo_session_1',
    directory: DIRECTORY,
    sandboxId: SANDBOX_ID,
    wrapperId,
    state: 'running',
  };
}

function fixture(
  overrides: {
    isRouteReady?: boolean;
    getSandboxStatus?: () => Promise<SandboxStatusSnapshot>;
  } = {}
) {
  const { storage, values } = fakeStorage();
  const request = vi.fn(async (): Promise<ControlPlaneControlResult> => ({
    ok: true,
    result: { pty: pty('pty_new') },
  }));
  const checkAccess = vi.fn(async (): Promise<'allowed' | 'denied'> => 'allowed');
  const terminals = createControlPlaneTerminals({
    state: { storage, getWebSockets: () => [] } as unknown as DurableObjectState,
    sessionId: SESSION_ID,
    getMetadata: () => metadata(),
    getDirectory: () => DIRECTORY,
    getWrapperId: async () => CURRENT_WRAPPER,
    isRouteReady: () => overrides.isRouteReady ?? true,
    getSandboxStatus: overrides.getSandboxStatus ?? (async () => sandboxStatus('active')),
    checkAccess,
    scheduleAuthorization: async () => undefined,
    request,
  });
  return { terminals, values, request, checkAccess };
}

describe('V2 control-plane terminals projection', () => {
  it('reports a sleeping sandbox without forwarding a terminal request', async () => {
    const { terminals, request } = fixture({
      isRouteReady: false,
      getSandboxStatus: async () => sandboxStatus('sleeping'),
    });

    await expect(
      terminals.create({ operationId: '66666666-6666-4666-8666-666666666666' })
    ).resolves.toEqual({
      success: false,
      error: SANDBOX_STATUS_DETAIL_MESSAGES.sandbox_stopped,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps the workspace message for a sandbox that is not asleep', async () => {
    const { terminals, request } = fixture({
      isRouteReady: false,
      getSandboxStatus: async () => sandboxStatus('active'),
    });

    await expect(
      terminals.create({ operationId: '77777777-7777-4777-8777-777777777777' })
    ).resolves.toEqual({
      success: false,
      error: 'Terminal unavailable until the workspace is prepared',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('surfaces a real terminal RPC failure instead of the workspace message', async () => {
    const { terminals, request } = fixture();
    request.mockRejectedValueOnce(new Error('PTY allocation failed'));

    await expect(
      terminals.create({ operationId: '88888888-8888-4888-8888-888888888888' })
    ).resolves.toEqual({ success: false, error: 'PTY allocation failed' });
  });

  it('checks existing terminal records that have no authorization lease', async () => {
    const { terminals, values, request, checkAccess } = fixture();
    values.set('control_terminal:pty_existing', record(CURRENT_WRAPPER, 'pty_existing'));
    checkAccess.mockResolvedValue('denied');
    request.mockResolvedValue({ ok: true, result: { success: true } });
    expect(await terminals.nextAuthorizationCheckAt()).not.toBeNull();
    await terminals.maintainAuthorization();
    expect(values.get('control_terminal:pty_existing')).toMatchObject({ state: 'ended' });
    expect(await terminals.nextAuthorizationCheckAt()).toBeNull();
    expect(request).toHaveBeenCalledWith(
      SANDBOX_ID,
      expect.objectContaining({ operation: 'close' })
    );
  });
  it('closes a PTY whose creation finishes after revocation', async () => {
    const { terminals, values, request, checkAccess } = fixture();
    const response = Promise.withResolvers<ControlPlaneControlResult>();
    request
      .mockImplementationOnce(() => response.promise)
      .mockResolvedValue({ ok: true, result: { success: true } });
    const creation = terminals.create({ operationId: crypto.randomUUID() });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    checkAccess.mockResolvedValue('denied');
    await terminals.revoke();
    response.resolve({ ok: true, result: { pty: pty('pty_late') } });
    expect(await creation).toMatchObject({ success: false });
    expect(values.get('control_terminal:pty_late')).toBeUndefined();
    expect(request).toHaveBeenLastCalledWith(
      SANDBOX_ID,
      expect.objectContaining({
        operation: 'close',
        payload: { ptyId: 'pty_late' },
      })
    );
  });
  it('ends running records and clears completions for a replaced wrapper', async () => {
    const { terminals, values, request } = fixture();
    const operationId = '44444444-4444-4444-8444-444444444444';
    values.set(`control_terminal:pty_stale`, record('wr_replaced', 'pty_stale'));
    values.set(`control_terminal_operation:${operationId}`, {
      operationId,
      record: record('wr_replaced', 'pty_stale'),
      result: { pty: pty('pty_stale') },
    });

    await expect(
      terminals.create({ operationId: '55555555-5555-4555-8555-555555555555' })
    ).resolves.toMatchObject({ success: true });
    expect(request).toHaveBeenCalledOnce();

    expect(values.get(`control_terminal:pty_stale`)).toMatchObject({ state: 'ended' });
    expect(values.get(`control_terminal_operation:${operationId}`)).toBeUndefined();
    expect(values.get(`control_terminal:pty_new`)).toMatchObject({
      wrapperId: CURRENT_WRAPPER,
      state: 'running',
    });
  });
});
