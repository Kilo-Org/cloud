import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { NextRequest } from 'next/server';
import type * as fixTicketsModule from '@/lib/auto-fix/db/fix-tickets';
import { deriveCallbackToken } from '@kilocode/worker-utils/callback-token';

const mockGetFixTicketBySessionId = jest.fn() as jest.MockedFunction<
  typeof fixTicketsModule.getFixTicketBySessionId
>;
const mockUpdateFixTicketStatus = jest.fn() as jest.MockedFunction<
  typeof fixTicketsModule.updateFixTicketStatus
>;
const mockTryDispatchPendingFixes = jest.fn();
const mockGetBotUserId = jest.fn();
const mockPostIssueComment = jest.fn();
const mockGenerateGitHubInstallationToken = jest.fn();
const mockGetIntegrationById = jest.fn();
const mockHandleCommentReply = jest.fn();
const mockHandleCreateIssuePR = jest.fn();

jest.mock('@/lib/config.server', () => ({
  CALLBACK_TOKEN_SECRET: 'test-callback-token-secret',
}));

jest.mock('@/lib/auto-fix/db/fix-tickets', () => ({
  getFixTicketBySessionId: mockGetFixTicketBySessionId,
  updateFixTicketStatus: mockUpdateFixTicketStatus,
}));

jest.mock('@/lib/auto-fix/dispatch/dispatch-pending-fixes', () => ({
  tryDispatchPendingFixes: mockTryDispatchPendingFixes,
}));

jest.mock('@/lib/bot-users/bot-user-service', () => ({
  getBotUserId: mockGetBotUserId,
}));

jest.mock('@/lib/auto-fix/github/post-comment', () => ({
  postIssueComment: mockPostIssueComment,
}));

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: mockGenerateGitHubInstallationToken,
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationById: mockGetIntegrationById,
}));

jest.mock('@/lib/auto-fix/github/handle-comment-reply', () => ({
  handleCommentReply: mockHandleCommentReply,
  sanitizePublicErrorMessage: (message: string) => message,
}));

jest.mock('@/lib/auto-fix/github/handle-create-issue-pr', () => ({
  handleCreateIssuePR: mockHandleCreateIssuePR,
}));

jest.mock('@/lib/utils.server', () => ({
  logExceptInTest: jest.fn(),
  errorExceptInTest: jest.fn(),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const CALLBACK_SECRET = 'test-callback-token-secret';
const TICKET_ID = 'ticket-1';
const SESSION_ID = 'cloud-agent-session-1';
const COMPLETED_PAYLOAD = {
  sessionId: SESSION_ID,
  status: 'completed',
};

type RequestOptions = {
  ticketId?: string;
  callbackToken?: string | null;
};

function makeRequest(body: Record<string, unknown>, options: RequestOptions = {}): NextRequest {
  const url = new URL('https://test.kilo.ai/api/internal/auto-fix/pr-callback');
  if (options.ticketId) {
    url.searchParams.set('ticketId', options.ticketId);
  }

  return {
    nextUrl: url,
    headers: {
      get: (name: string) => {
        if (name === 'X-Callback-Token') return options.callbackToken ?? null;
        return null;
      },
    },
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

function activeTicket(id = TICKET_ID) {
  return {
    id,
    status: 'running',
    review_comment_id: null,
    trigger_source: 'label',
    platform_integration_id: null,
  } as Awaited<ReturnType<typeof mockGetFixTicketBySessionId>>;
}

function terminalTicket(id = TICKET_ID) {
  return {
    id,
    status: 'completed',
    review_comment_id: null,
    trigger_source: 'label',
  } as Awaited<ReturnType<typeof mockGetFixTicketBySessionId>>;
}

import type { POST as POSTType } from './route';

let POST: typeof POSTType;

beforeEach(async () => {
  jest.clearAllMocks();
  ({ POST } = await import('./route'));
});

describe('POST /api/internal/auto-fix/pr-callback', () => {
  it('accepts token bound to the callback ticket', async () => {
    const callbackToken = await deriveCallbackToken({
      secret: CALLBACK_SECRET,
      scope: 'auto-fix-pr-callback',
      resourceParts: [TICKET_ID],
    });
    mockGetFixTicketBySessionId.mockResolvedValue(terminalTicket());

    const response = await POST(
      makeRequest(COMPLETED_PAYLOAD, { ticketId: TICKET_ID, callbackToken })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      message: 'Ticket already terminal',
    });
  });

  it('prefers a validated structured failure message', async () => {
    const callbackToken = await deriveCallbackToken({
      secret: CALLBACK_SECRET,
      scope: 'auto-fix-pr-callback',
      resourceParts: [TICKET_ID],
    });
    mockGetFixTicketBySessionId.mockResolvedValue(activeTicket());

    const response = await POST(
      makeRequest(
        {
          sessionId: SESSION_ID,
          status: 'failed',
          errorMessage: 'legacy error',
          failure: {
            stage: 'pre_dispatch',
            code: 'workspace_setup_failed',
            subtype: 'git_clone_timeout',
            attempts: 2,
            message: 'Repository clone timed out',
          },
        },
        { ticketId: TICKET_ID, callbackToken }
      )
    );

    expect(response.status).toBe(200);
    expect(mockUpdateFixTicketStatus).toHaveBeenCalledWith(
      TICKET_ID,
      'failed',
      expect.objectContaining({ errorMessage: 'Repository clone timed out' })
    );
  });

  it('falls back to the legacy failure message', async () => {
    const callbackToken = await deriveCallbackToken({
      secret: CALLBACK_SECRET,
      scope: 'auto-fix-pr-callback',
      resourceParts: [TICKET_ID],
    });
    mockGetFixTicketBySessionId.mockResolvedValue(activeTicket());

    const response = await POST(
      makeRequest(
        { sessionId: SESSION_ID, status: 'failed', errorMessage: 'legacy error' },
        { ticketId: TICKET_ID, callbackToken }
      )
    );

    expect(response.status).toBe(200);
    expect(mockUpdateFixTicketStatus).toHaveBeenCalledWith(
      TICKET_ID,
      'failed',
      expect.objectContaining({ errorMessage: 'legacy error' })
    );
  });

  it.each([
    { failure: { code: 'future_failure_code' } },
    { failure: { subtype: 'unknown_workspace_failure' } },
    { failure: { extra: true } },
    { failure: { attempts: -1 } },
    { failure: { message: 'x'.repeat(4_097) } },
  ])('discards incompatible failure and uses the legacy message: %o', async extension => {
    const callbackToken = await deriveCallbackToken({
      secret: CALLBACK_SECRET,
      scope: 'auto-fix-pr-callback',
      resourceParts: [TICKET_ID],
    });

    const response = await POST(
      makeRequest(
        { sessionId: SESSION_ID, status: 'failed', errorMessage: 'legacy error', ...extension },
        { ticketId: TICKET_ID, callbackToken }
      )
    );

    expect(response.status).toBe(200);
    expect(mockUpdateFixTicketStatus).toHaveBeenCalledWith(
      TICKET_ID,
      'failed',
      expect.objectContaining({ errorMessage: 'legacy error' })
    );
  });

  it('rejects token callbacks missing ticketId query binding', async () => {
    const callbackToken = await deriveCallbackToken({
      secret: CALLBACK_SECRET,
      scope: 'auto-fix-pr-callback',
      resourceParts: [TICKET_ID],
    });

    const response = await POST(makeRequest(COMPLETED_PAYLOAD, { callbackToken }));

    expect(response.status).toBe(401);
    expect(mockGetFixTicketBySessionId).not.toHaveBeenCalled();
  });

  it('rejects callback token scoped to a different ticket query', async () => {
    const callbackToken = await deriveCallbackToken({
      secret: CALLBACK_SECRET,
      scope: 'auto-fix-pr-callback',
      resourceParts: [TICKET_ID],
    });

    const response = await POST(
      makeRequest(COMPLETED_PAYLOAD, { ticketId: 'ticket-2', callbackToken })
    );

    expect(response.status).toBe(401);
    expect(mockGetFixTicketBySessionId).not.toHaveBeenCalled();
  });

  it('rejects valid ticket token when callback session resolves to another ticket', async () => {
    const callbackToken = await deriveCallbackToken({
      secret: CALLBACK_SECRET,
      scope: 'auto-fix-pr-callback',
      resourceParts: [TICKET_ID],
    });
    mockGetFixTicketBySessionId.mockResolvedValue(terminalTicket('ticket-2'));

    const response = await POST(
      makeRequest(COMPLETED_PAYLOAD, { ticketId: TICKET_ID, callbackToken })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'Ticket ID mismatch' });
  });
});
