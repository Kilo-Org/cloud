/**
 * Cross-DO rollback tests for conversation-creation partial failures.
 *
 * The happy-path integration is covered by `conversations-routes.test.ts`.
 * These tests wrap the real `MEMBERSHIP_DO` namespace in a Proxy that rejects
 * `addConversation` for a chosen member ID, then asserts that the conversation
 * DO has been destroyed and that any membership writes that did succeed were
 * rolled back.
 *
 * The Proxy handlers below forward unknown property access through
 * `Reflect.get` and bind any returned function to the real target. This is
 * necessary because workerd's RPC stubs (and DO namespace handles) rely on
 * internal slots that break when called through a Proxy receiver. Because
 * we're bridging typed RPC values, the generic forwarding path is `unknown`
 * and lint's strict any-checks would flag every property read — we disable
 * those rules file-wide since this is a pure test-double construct.
 */

/* oxlint-disable typescript-eslint/no-unsafe-assignment */
/* oxlint-disable typescript-eslint/no-unsafe-return */
/* oxlint-disable typescript-eslint/no-unsafe-call */
/* oxlint-disable typescript-eslint/no-unsafe-member-access */

import { env } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import type { ConversationDO } from '../do/conversation-do';
import type { MembershipDO } from '../do/membership-do';
import { createBotConversationFor, createConversationFor } from '../services/conversations';

const ownershipMap = new Map<string, Set<string>>();
const ownerMap = new Map<string, string>();

vi.mock('../services/sandbox-ownership', () => ({
  userOwnsSandbox: async (_env: Env, userId: string, sandboxId: string) =>
    ownershipMap.get(userId)?.has(sandboxId) ?? false,
  lookupSandboxOwnerUserId: async (_env: Env, sandboxId: string) => ownerMap.get(sandboxId) ?? null,
}));

function grantSandbox(userId: string, sandboxId: string) {
  let owned = ownershipMap.get(userId);
  if (!owned) {
    owned = new Set();
    ownershipMap.set(userId, owned);
  }
  owned.add(sandboxId);
  ownerMap.set(sandboxId, userId);
}

type MembershipStub = DurableObjectStub<MembershipDO>;
type MembershipNs = DurableObjectNamespace<MembershipDO>;

/**
 * Wrap a MembershipDO stub so `addConversation` rejects, delegating every
 * other property access to the underlying real stub with `this` bound
 * correctly (workerd's RPC stubs rely on internal slots that require the
 * original receiver).
 */
function stubWithFailingAdd(real: MembershipStub): MembershipStub {
  const handler: ProxyHandler<MembershipStub> = {
    get(target, prop, receiver) {
      if (prop === 'addConversation') {
        return async () => {
          throw new Error('simulated MembershipDO.addConversation failure');
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  };
  return new Proxy(real, handler);
}

/**
 * Build an env whose MEMBERSHIP_DO namespace rejects `addConversation` for
 * `failMemberId`. All other namespace operations forward to the real runtime.
 */
function envWithFailingAdd(failMemberId: string): Env {
  const realNs: MembershipNs = env.MEMBERSHIP_DO;
  const failingIdStr = realNs.idFromName(failMemberId).toString();
  const nsHandler: ProxyHandler<MembershipNs> = {
    get(target, prop, receiver) {
      if (prop === 'get') {
        return (id: DurableObjectId, options?: DurableObjectNamespaceGetDurableObjectOptions) => {
          const real = target.get(id, options);
          return id.toString() === failingIdStr ? stubWithFailingAdd(real) : real;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  };
  const wrappedNs = new Proxy(realNs, nsHandler);
  return { ...env, MEMBERSHIP_DO: wrappedNs };
}

function getConvStub(convId: string): DurableObjectStub<ConversationDO> {
  return env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(convId));
}

function getMemberStub(memberId: string): MembershipStub {
  return env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(memberId));
}

describe('createConversationFor — partial-failure rollback', () => {
  it('rolls back when the bot MembershipDO write fails', async () => {
    grantSandbox('user-rb1', 'sandbox-rb1');
    const botId = 'bot:kiloclaw:sandbox-rb1';
    const brokenEnv = envWithFailingAdd(botId);

    await expect(
      createConversationFor(brokenEnv, 'user-rb1', {
        sandboxId: 'sandbox-rb1',
        title: 'will-be-rolled-back',
      })
    ).rejects.toThrow(/simulated MembershipDO.addConversation failure/);

    // No membership rows should remain for either member.
    const userList = await getMemberStub('user-rb1').listConversations();
    expect(userList.conversations).toEqual([]);
    const botList = await getMemberStub(botId).listConversations();
    expect(botList.conversations).toEqual([]);
  });

  it('rolls back when the user MembershipDO write fails', async () => {
    grantSandbox('user-rb2', 'sandbox-rb2');
    const botId = 'bot:kiloclaw:sandbox-rb2';
    const brokenEnv = envWithFailingAdd('user-rb2');

    await expect(
      createConversationFor(brokenEnv, 'user-rb2', {
        sandboxId: 'sandbox-rb2',
      })
    ).rejects.toThrow(/simulated MembershipDO.addConversation failure/);

    const userList = await getMemberStub('user-rb2').listConversations();
    expect(userList.conversations).toEqual([]);
    const botList = await getMemberStub(botId).listConversations();
    expect(botList.conversations).toEqual([]);
  });
});

describe('createBotConversationFor — partial-failure rollback', () => {
  it('rolls back when one additional member MembershipDO write fails', async () => {
    grantSandbox('user-rb3-owner', 'sandbox-rb3');
    const botId = 'bot:kiloclaw:sandbox-rb3';
    const failingMember = 'user-rb3-additional-fail';
    const brokenEnv = envWithFailingAdd(failingMember);

    await expect(
      createBotConversationFor(brokenEnv, {
        sandboxId: 'sandbox-rb3',
        title: 'bot-rollback',
        additionalMembers: [failingMember, 'user-rb3-additional-ok'],
      })
    ).rejects.toThrow(/simulated MembershipDO.addConversation failure/);

    // None of the memberships should retain a row — the ones that succeeded
    // (owner, bot, other additional member) must have been rolled back.
    for (const id of ['user-rb3-owner', botId, 'user-rb3-additional-ok', failingMember]) {
      const { conversations } = await getMemberStub(id).listConversations();
      expect(conversations, `member ${id} should have no conversations`).toEqual([]);
    }
  });

  it('rolls back when the bot MembershipDO write fails in bot-creation path', async () => {
    grantSandbox('user-rb4-owner', 'sandbox-rb4');
    const botId = 'bot:kiloclaw:sandbox-rb4';
    const brokenEnv = envWithFailingAdd(botId);

    await expect(createBotConversationFor(brokenEnv, { sandboxId: 'sandbox-rb4' })).rejects.toThrow(
      /simulated MembershipDO.addConversation failure/
    );

    const ownerList = await getMemberStub('user-rb4-owner').listConversations();
    expect(ownerList.conversations).toEqual([]);
    const botList = await getMemberStub(botId).listConversations();
    expect(botList.conversations).toEqual([]);
  });
});

describe('rollback does not block subsequent creation', () => {
  it('leaves caller membership clean so a retry succeeds and initializes a fresh DO', async () => {
    grantSandbox('user-rb5', 'sandbox-rb5');
    const botId = 'bot:kiloclaw:sandbox-rb5';
    const brokenEnv = envWithFailingAdd(botId);

    await expect(
      createConversationFor(brokenEnv, 'user-rb5', { sandboxId: 'sandbox-rb5' })
    ).rejects.toThrow();

    const afterFailure = await getMemberStub('user-rb5').listConversations();
    expect(afterFailure.conversations).toEqual([]);

    const retryResult = await createConversationFor(env, 'user-rb5', {
      sandboxId: 'sandbox-rb5',
      title: 'retry-ok',
    });
    expect(retryResult.ok).toBe(true);

    const afterRetry = await getMemberStub('user-rb5').listConversations();
    expect(afterRetry.conversations).toHaveLength(1);
    expect(afterRetry.conversations[0].title).toBe('retry-ok');

    if (retryResult.ok) {
      const info = await getConvStub(retryResult.conversationId).getInfo();
      expect(info).not.toBeNull();
    }
  });
});
