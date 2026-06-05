import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import {
  postMessageAsUser,
  type PostMessageAsUserParams,
  type PostMessageAsUserResult,
} from '../services/post-message-as-user';

/** Map of userId → set of sandbox IDs they own. */
const ownershipMap = new Map<string, Set<string>>();

vi.mock('../services/sandbox-ownership', () => ({
  userOwnsSandbox: async (_env: Env, userId: string, sandboxId: string) =>
    ownershipMap.get(userId)?.has(sandboxId) ?? false,
}));

vi.mock('../services/user-lookup', () => ({
  resolveUserDisplayInfo: async () => new Map(),
}));

function grantSandbox(userId: string, sandboxId: string) {
  if (!ownershipMap.has(userId)) ownershipMap.set(userId, new Set());
  ownershipMap.get(userId)!.add(sandboxId);
}

function makeEnv(): Env {
  return {
    ...env,
    EVENT_SERVICE: {
      fetch: env.EVENT_SERVICE.fetch.bind(env.EVENT_SERVICE),
      connect: env.EVENT_SERVICE.connect.bind(env.EVENT_SERVICE),
      pushEvent: async () => true,
    },
  } satisfies Env;
}

// Build a real ExecutionContext, run the callee, then drain pending
// waitUntil work before asserting so isolated-storage cleanup between tests
// does not race. Mirrors the pattern in helpers.ts.
async function runPost(
  testEnv: Env,
  params: PostMessageAsUserParams
): Promise<PostMessageAsUserResult> {
  const ctx = createExecutionContext();
  const result = await postMessageAsUser(testEnv, { waitUntil: p => ctx.waitUntil(p) }, params);
  await waitOnExecutionContext(ctx);
  return result;
}

describe('postMessageAsUser', () => {
  it('auto-creates a conversation on first delivery and posts the message', async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const sandboxId = `sandbox-${crypto.randomUUID()}`;
    grantSandbox(userId, sandboxId);

    const result = await runPost(makeEnv(), {
      userId,
      sandboxId,
      message: 'webhook payload arrived',
      source: 'webhook',
      autoCreateConversation: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conversationCreated).toBe(true);
    expect(result.conversationId).toBeTruthy();
    expect(result.messageId).toBeTruthy();
  });

  it('reuses the existing conversation on subsequent deliveries', async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const sandboxId = `sandbox-${crypto.randomUUID()}`;
    grantSandbox(userId, sandboxId);
    const testEnv = makeEnv();

    const first = await runPost(testEnv, {
      userId,
      sandboxId,
      message: 'first',
      source: 'webhook',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.conversationCreated).toBe(true);

    const second = await runPost(testEnv, {
      userId,
      sandboxId,
      message: 'second',
      source: 'webhook',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.conversationCreated).toBe(false);
    expect(second.conversationId).toBe(first.conversationId);
  });

  it('forceNewConversation always creates a fresh conversation even when one exists', async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const sandboxId = `sandbox-${crypto.randomUUID()}`;
    grantSandbox(userId, sandboxId);
    const testEnv = makeEnv();

    const first = await runPost(testEnv, {
      userId,
      sandboxId,
      message: 'first',
      source: 'webhook',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const installed = await runPost(testEnv, {
      userId,
      sandboxId,
      message: 'installed byte prompt',
      source: 'install',
      forceNewConversation: true,
    });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    // A brand-new conversation, not the pre-existing one.
    expect(installed.conversationCreated).toBe(true);
    expect(installed.conversationId).not.toBe(first.conversationId);
  });

  it('returns no_conversation when autoCreateConversation is false and none exists', async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const sandboxId = `sandbox-${crypto.randomUUID()}`;
    grantSandbox(userId, sandboxId);

    const result = await runPost(makeEnv(), {
      userId,
      sandboxId,
      message: 'should fail',
      source: 'onboarding-warmup',
      autoCreateConversation: false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('no_conversation');
  });

  it('surfaces forbidden when the user does not own the sandbox', async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const sandboxId = `sandbox-${crypto.randomUUID()}`;
    // intentionally NOT granting ownership

    const result = await runPost(makeEnv(), {
      userId,
      sandboxId,
      message: 'should be forbidden',
      source: 'webhook',
      autoCreateConversation: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('forbidden');
  });

  it('rejects forbidden even when a stale conversation already exists', async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const sandboxId = `sandbox-${crypto.randomUUID()}`;
    const testEnv = makeEnv();

    // Seed: grant ownership long enough to create a conversation.
    grantSandbox(userId, sandboxId);
    const seed = await runPost(testEnv, {
      userId,
      sandboxId,
      message: 'seed message',
      source: 'webhook',
    });
    expect(seed.ok).toBe(true);

    // Revoke ownership (simulates instance destroyed / reassigned). The
    // conversation still exists in MEMBERSHIP_DO, so the existing-conversation
    // path runs without the create-time ownership check.
    ownershipMap.get(userId)?.delete(sandboxId);

    const result = await runPost(testEnv, {
      userId,
      sandboxId,
      message: 'should now be forbidden',
      source: 'webhook',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('forbidden');
  });

  it('rejects empty messages with invalid_request before any side effects', async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const sandboxId = `sandbox-${crypto.randomUUID()}`;
    grantSandbox(userId, sandboxId);

    const result = await runPost(makeEnv(), {
      userId,
      sandboxId,
      message: '   ',
      source: 'webhook',
      autoCreateConversation: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_request');
  });

  it('rejects messages exceeding the chat content limit with invalid_request', async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const sandboxId = `sandbox-${crypto.randomUUID()}`;
    grantSandbox(userId, sandboxId);

    const result = await runPost(makeEnv(), {
      userId,
      sandboxId,
      // Larger than MESSAGE_TEXT_MAX_CHARS (8000) so the public schema rejects it.
      message: 'x'.repeat(9000),
      source: 'webhook',
      autoCreateConversation: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_request');
  });

  it('accepts correlation metadata without throwing', async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const sandboxId = `sandbox-${crypto.randomUUID()}`;
    grantSandbox(userId, sandboxId);

    const result = await runPost(makeEnv(), {
      userId,
      sandboxId,
      message: 'with correlation',
      source: 'webhook',
      correlation: { triggerId: 'trig-1', webhookRequestId: 'req-1' },
    });

    expect(result.ok).toBe(true);
  });
});
