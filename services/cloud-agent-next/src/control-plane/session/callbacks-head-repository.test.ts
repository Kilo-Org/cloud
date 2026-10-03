import { describe, expect, it, vi } from 'vitest';
import { parseSessionMetadata, type SessionMetadata } from '../../persistence/session-metadata.js';
import type { LatestAssistantMessage } from '../../session/types.js';
import {
  callbackOutboxKey,
  createMessageCallbacks,
  parseCallbackOutboxValue,
} from './callbacks.js';
import type { SessionMessage } from './messages.js';

const SESSION_ID = 'workspace_callback_test';
const KILO_SESSION_ID = 'kilo_callback_test';
const MESSAGE_ID = 'message_callback_test';

type MemoryKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
  list<T>(options?: { prefix?: string }): Iterable<[string, T]>;
};

function memoryKv(): MemoryKv {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: <T>(key: string, value: T) => values.set(key, structuredClone(value)),
    delete: key => values.delete(key),
    list: <T>(options?: { prefix?: string }) =>
      [...values.entries()]
        .filter(([key]) => options?.prefix === undefined || key.startsWith(options.prefix))
        .map(([key, value]) => [key, structuredClone(value) as T] as [string, T]),
  };
}

function metadataWithCallback(
  overrides: Record<string, unknown> = {},
  repository: Record<string, unknown> = {
    type: 'git',
    url: 'https://example.com/repository.git',
    upstreamBranch: 'main',
  }
): SessionMetadata {
  return parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: { sessionId: SESSION_ID, userId: 'user_callback_test' },
    auth: { kiloSessionId: KILO_SESSION_ID },
    repository,
    callback: { target: { url: 'https://example.com/callback' } },
    workspace: { workspacePath: '/workspace/callback', branchName: 'feature/callback' },
    lifecycle: { version: 1, timestamp: 1 },
    ...overrides,
  });
}

function message(
  state: SessionMessage['state'] = 'completed',
  reason: string | null = state === 'completed' ? null : 'runtime_unhealthy'
): SessionMessage {
  return {
    messageId: MESSAGE_ID,
    intent: {
      messageId: MESSAGE_ID,
      turn: { type: 'prompt', prompt: 'hello' },
      agent: { mode: 'code', model: 'test-model' },
    },
    state,
    createdAt: 1,
    acceptedAt: 1,
    settledAt: 2,
    reason,
  };
}

function createHarness(metadata: SessionMetadata = metadataWithCallback()) {
  const kv = memoryKv();
  const callbacks = createMessageCallbacks({
    storage: { kv: kv as unknown as DurableObjectStorage['kv'] },
    getMetadata: () => metadata,
    getCallbackQueue: () => undefined,
    getAssistantMessageForUserMessage: (): LatestAssistantMessage | null => null,
  });
  return { kv, callbacks };
}

describe('control-plane callback head repository', () => {
  it('reports the GitHub repository the reported branch was pushed to', () => {
    const harness = createHarness(
      metadataWithCallback({}, { type: 'github', repo: 'maphew/kilo-cloud', upstreamBranch: 'main' })
    );

    expect(harness.callbacks.persistDrainedBatchCallback([message()], new Set([MESSAGE_ID]))).toBe(
      true
    );

    const stored = harness.kv.get<unknown>(callbackOutboxKey(MESSAGE_ID));
    expect(parseCallbackOutboxValue(stored)?.job.payload).toMatchObject({
      lastSeenBranch: 'main',
      headRepoFullName: 'maphew/kilo-cloud',
    });
  });

  it('omits headRepoFullName for a repository that is not addressable as owner/repo', () => {
    const harness = createHarness();

    expect(harness.callbacks.persistDrainedBatchCallback([message()], new Set([MESSAGE_ID]))).toBe(
      true
    );

    const stored = harness.kv.get<unknown>(callbackOutboxKey(MESSAGE_ID));
    const payload = parseCallbackOutboxValue(stored)?.job.payload;
    expect(payload).toBeDefined();
    expect(payload?.headRepoFullName).toBeUndefined();
  });

  it('keeps reporting the head repository when the metadata object is replaced', () => {
    const metadata = metadataWithCallback(
      {},
      { type: 'github', repo: 'maphew/kilo-cloud', upstreamBranch: 'main' }
    );
    const harness = createHarness(metadata);
    vi.spyOn(harness.callbacks, 'persistDrainedBatchCallback');

    expect(harness.callbacks.persistDrainedBatchCallback([message()], new Set([MESSAGE_ID]))).toBe(
      true
    );
    expect(parseCallbackOutboxValue(harness.kv.get<unknown>(callbackOutboxKey(MESSAGE_ID)))?.job.payload).toMatchObject({
      headRepoFullName: 'maphew/kilo-cloud',
    });
  });
});
