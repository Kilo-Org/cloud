import React from 'react';
import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PrefetchedCloudChat as PrefetchedCloudChatComponent } from './PrefetchedCloudChat';

Object.assign(globalThis, { React });

const kiloSessionId = 'ses_12345678901234567890123456';
const cloudAgentSessionId = 'workspace_00000000-0000-4000-8000-000000000001';
const organizationId = '00000000-0000-4000-8000-0000000000aa';

const mockGetSession = jest.fn<(input: unknown) => Promise<unknown>>();
const mockIngestPage = jest.fn<(input: unknown) => Promise<unknown>>();
const mockCloudPage = jest.fn<(input: unknown) => Promise<unknown>>();
const mockOrgCloudPage = jest.fn<(input: unknown) => Promise<unknown>>();

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/trpc/init', () => ({
  createTRPCContext: async () => ({ user: { id: 'oauth/test' } }),
}));
jest.mock('@/routers/root-router', () => ({
  rootRouter: {
    createCaller: () => ({
      cliSessionsV2: {
        getWithRuntimeState: (input: unknown) => mockGetSession(input),
        getSessionMessagesPage: (input: unknown) => mockIngestPage(input),
      },
      cloudAgentNext: { getSessionMessagesPage: (input: unknown) => mockCloudPage(input) },
      organizations: {
        cloudAgentNext: { getSessionMessagesPage: (input: unknown) => mockOrgCloudPage(input) },
      },
    }),
  },
}));

let PrefetchedCloudChat: typeof PrefetchedCloudChatComponent;

beforeAll(async () => {
  ({ PrefetchedCloudChat } = await import('./PrefetchedCloudChat'));
});

function session(overrides: Record<string, unknown> = {}) {
  return {
    cloud_agent_session_id: cloudAgentSessionId,
    title: 'Chat',
    organization_id: null,
    git_url: null,
    git_branch: null,
    cloud_agent_worktree_id: null,
    runtimeState: null,
    associatedPr: null,
    total_cost_microdollars: 0,
    ...overrides,
  };
}

function previewPage() {
  return {
    kind: 'success',
    source: { version: 'v1' },
    info: { id: kiloSessionId },
    messages: [
      {
        info: {
          id: 'msg_1',
          sessionID: kiloSessionId,
          role: 'user',
          time: { created: 1 },
          agent: 'code',
          model: { providerID: 'kilo', modelID: 'kilo/fake' },
        },
        parts: [
          { id: 'prt_1', sessionID: kiloSessionId, messageID: 'msg_1', type: 'text', text: 'hi' },
        ],
      },
    ],
    nextCursor: 'older',
    omittedItemCount: 0,
    updateCursor: 7,
    totalCostMicrodollars: 0,
  };
}

async function seededPage(organization: string | null) {
  const element = await PrefetchedCloudChat({
    sessionId: kiloSessionId,
    organizationId: organization,
    children: null,
  });
  const { QueryClient, hydrate } = await import('@tanstack/react-query');
  const client = new QueryClient();
  hydrate(client, element.props.state);
  const { transcriptCacheKey, transcriptCacheScope } = await import('../session-transcript-cache');
  const page = client.getQueryData<{ messages: unknown[] }>(
    transcriptCacheKey(transcriptCacheScope('oauth/test', organization), kiloSessionId)
  );
  client.clear();
  return page;
}

describe('chat server prefetch', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockIngestPage.mockReset();
    mockCloudPage.mockReset();
    mockOrgCloudPage.mockReset();
    mockCloudPage.mockResolvedValue(previewPage());
    mockOrgCloudPage.mockResolvedValue(previewPage());
  });

  it('seeds a Cloud Agent chat from the preview history the browser reads', async () => {
    mockGetSession.mockResolvedValue(session());

    const page = await seededPage(null);

    expect(mockCloudPage).toHaveBeenCalledWith({
      sessionId: cloudAgentSessionId,
      toolDisplay: 'preview',
      limit: 20,
    });
    expect(mockIngestPage).not.toHaveBeenCalled();
    expect(page?.messages).toHaveLength(1);
  });

  it('reads an organization Cloud Agent chat through the organization procedure', async () => {
    mockGetSession.mockResolvedValue(session({ organization_id: organizationId }));

    await seededPage(organizationId);

    expect(mockOrgCloudPage).toHaveBeenCalledWith({
      sessionId: cloudAgentSessionId,
      toolDisplay: 'preview',
      limit: 20,
      organizationId,
    });
    expect(mockCloudPage).not.toHaveBeenCalled();
  });

  it('keeps the session-ingest page for chats without a Cloud Agent workspace', async () => {
    mockGetSession.mockResolvedValue(session({ cloud_agent_session_id: null }));
    mockIngestPage.mockResolvedValue({
      kiloSessionId,
      history: { messages: [], nextCursor: null, omittedItemCount: 0 },
    });

    await seededPage(null);

    expect(mockIngestPage).toHaveBeenCalledTimes(1);
    expect(mockCloudPage).not.toHaveBeenCalled();
  });

  it('seeds nothing for a chat in another account context', async () => {
    mockGetSession.mockResolvedValue(session({ organization_id: organizationId }));

    expect(await seededPage(null)).toBeUndefined();
    expect(mockCloudPage).not.toHaveBeenCalled();
    expect(mockOrgCloudPage).not.toHaveBeenCalled();
  });
});
