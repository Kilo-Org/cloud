import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listCloudAgentChildSessionsMock, assertCloudAgentManagementRequestMock } = vi.hoisted(
  () => ({
    listCloudAgentChildSessionsMock: vi.fn(),
    assertCloudAgentManagementRequestMock: vi.fn(),
  })
);

vi.mock('../../cloud-agent-child-management.js', () => ({
  listCloudAgentChildSessions: listCloudAgentChildSessionsMock,
  assertCloudAgentManagementRequest: assertCloudAgentManagementRequestMock,
}));

import type { TRPCContext } from '../../types.js';
import { router } from '../auth.js';
import { listChildSessions } from './list-child-sessions.js';

const authority = {
  version: 1 as const,
  ownerId: 'owner',
  parentSessionId: 'workspace_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  organizationId: null,
  authorizationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

function context(withAuthority = true): TRPCContext {
  return {
    env: {} as TRPCContext['env'],
    request: new Request('https://worker.test/trpc/listChildSessions'),
    userId: 'owner',
    authToken: 'token',
    ...(withAuthority ? { cloudAgentAuthority: authority } : {}),
  };
}

beforeEach(() => {
  listCloudAgentChildSessionsMock.mockReset();
  assertCloudAgentManagementRequestMock.mockReset();
  assertCloudAgentManagementRequestMock.mockResolvedValue(undefined);
});

describe('listChildSessions', () => {
  it('uses the authority parent and default page size', async () => {
    listCloudAgentChildSessionsMock.mockResolvedValue({
      sessions: [
        {
          cloudAgentSessionId: 'workspace_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          worktreeId: 'worktree_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
      ],
      nextCursor: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    });
    const caller = router({ listChildSessions }).createCaller(context());
    await expect(caller.listChildSessions({})).resolves.toEqual({
      sessions: [
        {
          cloudAgentSessionId: 'workspace_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          worktreeId: 'worktree_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
      ],
      nextCursor: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    });
    expect(assertCloudAgentManagementRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ authority, path: 'listChildSessions', rawInput: {} })
    );
    expect(listCloudAgentChildSessionsMock).toHaveBeenCalledWith({
      env: expect.anything(),
      authority,
      limit: 20,
    });
  });

  it('rejects unknown fields and an out-of-range limit', async () => {
    const caller = router({ listChildSessions }).createCaller(context());
    await expect(caller.listChildSessions({ extra: true } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(caller.listChildSessions({ limit: 51 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(listCloudAgentChildSessionsMock).not.toHaveBeenCalled();
  });

  it('rejects callers without a Cloud Agent authority', async () => {
    const caller = router({ listChildSessions }).createCaller(context(false));
    await expect(caller.listChildSessions({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(listCloudAgentChildSessionsMock).not.toHaveBeenCalled();
  });
});
