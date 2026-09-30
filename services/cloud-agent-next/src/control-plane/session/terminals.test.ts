import { describe, expect, it, vi } from 'vitest';
import { parseSessionMetadata } from '../../persistence/session-metadata.js';
import type { ControlPlaneControlResult } from '../../shared/control-plane-protocol.js';
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

function fixture() {
  const { storage, values } = fakeStorage();
  const request = vi.fn(
    async (): Promise<ControlPlaneControlResult> => ({
      ok: true,
      result: { pty: pty('pty_new') },
    })
  );
  const terminals = createControlPlaneTerminals({
    state: { storage } as unknown as DurableObjectState,
    sessionId: SESSION_ID,
    getMetadata: () => metadata(),
    getDirectory: () => DIRECTORY,
    getWrapperId: async () => CURRENT_WRAPPER,
    isRouteReady: () => true,
    request,
  });
  return { terminals, values, request };
}

describe('V2 control-plane terminals projection', () => {
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
