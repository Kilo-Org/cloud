import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { TRPCClient } from '@trpc/client';
import type { RootRouter } from '@/routers/root-router';
import { releaseLocalSessionUploads, type LocalSessionRequest } from './local-session-request';

const personalRelease =
  jest.fn<TRPCClient<RootRouter>['cloudAgentNext']['releasePendingUploads']['mutate']>();
const organizationRelease =
  jest.fn<
    TRPCClient<RootRouter>['organizations']['cloudAgentNext']['releasePendingUploads']['mutate']
  >();
const client = {
  cloudAgentNext: { releasePendingUploads: { mutate: personalRelease } },
  organizations: {
    cloudAgentNext: { releasePendingUploads: { mutate: organizationRelease } },
  },
} as unknown as TRPCClient<RootRouter>;

const input = {
  githubRepo: 'kilo/repo',
  prompt: 'Fix this',
  mode: 'code',
  model: 'test/model',
  attachments: { path: 'message-1', files: ['notes.txt', 'image.png'] },
};

describe('releaseLocalSessionUploads', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    personalRelease.mockResolvedValue({ success: true });
    organizationRelease.mockResolvedValue({ success: true });
  });

  it('releases full attachment keys for a personal session and OAuth user ID', async () => {
    await releaseLocalSessionUploads(client, { kind: 'new-session', input }, 'oauth/user-1');

    expect(personalRelease).toHaveBeenCalledWith({
      objectKeys: [
        'oauth/user-1/cloud-agent/message-1/notes.txt',
        'oauth/user-1/cloud-agent/message-1/image.png',
      ],
    });
    expect(organizationRelease).not.toHaveBeenCalled();
  });

  it('uses the request organization when releasing organization uploads', async () => {
    await releaseLocalSessionUploads(
      client,
      { kind: 'new-organization-session', input: { ...input, organizationId: 'org-1' } },
      'user-1'
    );

    expect(organizationRelease).toHaveBeenCalledWith({
      organizationId: 'org-1',
      objectKeys: [
        'user-1/cloud-agent/message-1/notes.txt',
        'user-1/cloud-agent/message-1/image.png',
      ],
    });
    expect(personalRelease).not.toHaveBeenCalled();
  });

  it.each<LocalSessionRequest>([
    { kind: 'worktree-chat', sourceKiloSessionId: 'ses_source' },
    { kind: 'new-session', input: { ...input, attachments: undefined } },
    { kind: 'new-session', input: { ...input, attachments: { path: 'message-1', files: [] } } },
  ])('does not release requests without attachments: %j', async request => {
    await releaseLocalSessionUploads(client, request, 'user-1');

    expect(personalRelease).not.toHaveBeenCalled();
    expect(organizationRelease).not.toHaveBeenCalled();
  });
});
