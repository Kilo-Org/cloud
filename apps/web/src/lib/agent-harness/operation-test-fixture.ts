import { afterEach, beforeEach, jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { TRPCError } from '@trpc/server';
import type * as Authorization from './authorization';
import type * as Contract from './operation-contract';
import type * as Runtime from '@kilocode/db/quick-chat-runtime';

export const conversationId = '11111111-1111-4111-8111-111111111111';
export const operationId = '22222222-2222-4222-8222-222222222222';
export const runId = '33333333-3333-4333-8333-333333333333';
export const toolCallId = '44444444-4444-4444-8444-444444444444';
export const originalTime = 1788000000000;
export const authority = {
  threadId: conversationId,
  userId: 'oauth/owner',
  organizationId: runId,
  generation: 0,
};
export const access = {
  active: true,
  role: true,
  expires: new Date(originalTime + 3600000).toISOString(),
};
export const primary = {
  query: {
    agent_harness_conversation_grants: {
      findFirst: async () => ({
        id: runId,
        thread_id: conversationId,
        user_id: authority.userId,
        generation: 0,
        revoked_at: null,
        expires_at: access.expires,
      }),
    },
    agent_harness_conversation_registry: {
      findFirst: async () => ({
        thread_id: conversationId,
        user_id: authority.userId,
        organization_id: authority.organizationId,
        generation: 0,
      }),
    },
    kilocode_users: { findFirst: async () => ({ id: authority.userId, blocked_reason: null }) },
  },
  update: () => ({ set: () => ({ where: async () => undefined }) }),
};
export const runtime = { lookupThread: async () => (access.active ? authority : null) };
jest.mock('@/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'test-signing-key',
  INTERNAL_API_SECRET: 'test-service-key',
}));
jest.mock('./clients', () => ({
  harnessAccessDenied: () => {
    throw new TRPCError({ code: 'FORBIDDEN' });
  },
}));
jest.mock('@/routers/organizations/utils', () => ({
  ensureOrganizationAccess: async () => {
    if (!access.role) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'secret-role-details' });
    return 'owner';
  },
}));
jest.mock('@/lib/drizzle', () => ({ db: primary }));
jest.mock('@kilocode/db/quick-chat-runtime', () => ({
  ...jest.requireActual<typeof Runtime>('@kilocode/db/quick-chat-runtime'),
  createQuickChatRuntime: () => runtime,
}));
const { authorizeHarnessCapability, harnessInputDigest } =
  jest.requireActual<typeof Authorization>('./authorization');
const { HarnessOperationSchema, harnessOperationScope } =
  jest.requireActual<typeof Contract>('./operation-contract');
export const call = (name = 'kilo.organizations', args: unknown = {}) => ({
  type: 'execute',
  conversationId,
  operationId,
  runId,
  toolCallId,
  request: { name, arguments: args },
  dispatchStartedAt: originalTime,
});
export function capability(raw: unknown) {
  const input = HarnessOperationSchema.parse(raw);
  return jwt.sign(
    {
      grantId: runId,
      authority,
      scope: {
        audience: 'agent-harness:operations',
        conversationId,
        operation: input.type,
        definitionVersion: '1',
        inputDigest: harnessInputDigest(JSON.parse(JSON.stringify(input))),
        dispatchId: operationId,
        target: { kind: 'backend' },
      },
    },
    'test-signing-key',
    {
      issuer: 'agent-harness',
      audience: 'agent-harness:operations',
      expiresIn: 60,
    }
  );
}
export async function authorizedInput(raw: unknown, token = capability(raw)) {
  const input = HarnessOperationSchema.parse(JSON.parse(JSON.stringify(raw)));
  const scope = harnessOperationScope(input);
  return { input, scope, ...(await authorizeHarnessCapability(token, scope)) };
}
beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(originalTime + 1);
  access.expires = new Date(originalTime + 3600000).toISOString();
  access.active = access.role = true;
});
afterEach(() => jest.restoreAllMocks());
