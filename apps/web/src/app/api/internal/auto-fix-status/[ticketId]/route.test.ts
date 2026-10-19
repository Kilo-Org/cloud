import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { NextRequest } from 'next/server';
import type * as fixTicketsModule from '@/lib/auto-fix/db/fix-tickets';

const mockGetFixTicketById = jest.fn() as jest.MockedFunction<
  typeof fixTicketsModule.getFixTicketById
>;
const mockUpdateFixTicketStatus = jest.fn() as jest.MockedFunction<
  typeof fixTicketsModule.updateFixTicketStatus
>;
const mockTryDispatchPendingFixes = jest.fn();
const mockGetBotUserId = jest.fn();

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-internal-secret',
}));

jest.mock('@/lib/auto-fix/db/fix-tickets', () => ({
  getFixTicketById: mockGetFixTicketById,
  updateFixTicketStatus: mockUpdateFixTicketStatus,
}));

jest.mock('@/lib/auto-fix/dispatch/dispatch-pending-fixes', () => ({
  tryDispatchPendingFixes: mockTryDispatchPendingFixes,
}));

jest.mock('@/lib/bot-users/bot-user-service', () => ({
  getBotUserId: mockGetBotUserId,
}));

jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  logExceptInTest: jest.fn(),
  errorExceptInTest: jest.fn(),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const SECRET = 'test-internal-secret';
const TICKET_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

type RequestOptions = {
  secret?: string | null;
  ticketId?: string;
};

function makeRequest(body: unknown, options: RequestOptions = {}): NextRequest {
  const url = new URL(
    `https://test.kilo.ai/api/internal/auto-fix-status/${options.ticketId ?? TICKET_ID}`
  );
  return {
    nextUrl: url,
    headers: {
      get: (name: string) => {
        if (name.toLowerCase() === 'x-internal-secret')
          return options.secret === undefined ? SECRET : options.secret;
        return null;
      },
    },
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

function pendingTicket() {
  return {
    id: TICKET_ID,
    status: 'pending',
    review_comment_id: null,
    trigger_source: 'label',
    owned_by_organization_id: null,
    owned_by_user_id: 'user-1',
  } as Awaited<ReturnType<typeof mockGetFixTicketById>>;
}

function routeContext(ticketId: string) {
  return { params: Promise.resolve({ ticketId }) };
}

import type { POST as POSTType } from './route';

let POST: typeof POSTType;

beforeEach(async () => {
  jest.clearAllMocks();
  mockGetFixTicketById.mockResolvedValue(pendingTicket());
  mockUpdateFixTicketStatus.mockResolvedValue(undefined);
  ({ POST } = await import('./route'));
});

describe('POST /api/internal/auto-fix-status/[ticketId]', () => {
  it('accepts a valid update and forwards only the parsed request fields', async () => {
    const res = await POST(
      makeRequest({ status: 'running', sessionId: 'session-1' }),
      routeContext(TICKET_ID)
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });
    expect(mockUpdateFixTicketStatus).toHaveBeenCalledTimes(1);
    expect(mockUpdateFixTicketStatus).toHaveBeenCalledWith(TICKET_ID, 'running', {
      sessionId: 'session-1',
      cliSessionId: undefined,
      prNumber: undefined,
      prUrl: undefined,
      prBranch: undefined,
      errorMessage: undefined,
    });
  });

  it('rejects an unknown status value with 400 and does not write', async () => {
    const res = await POST(makeRequest({ status: 'pending-again' }), routeContext(TICKET_ID));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Invalid payload');
    expect(mockUpdateFixTicketStatus).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID ticketId with 400 and does not write', async () => {
    const res = await POST(
      makeRequest({ status: 'running' }, { ticketId: 'not-a-uuid' }),
      routeContext('not-a-uuid')
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Invalid payload');
    expect(mockUpdateFixTicketStatus).not.toHaveBeenCalled();
  });

  it('rejects a completedAt field in the request body with 400 and does not write', async () => {
    const res = await POST(
      makeRequest({
        status: 'running',
        sessionId: 'session-1',
        completedAt: '2026-01-01T00:00:00Z',
      }),
      routeContext(TICKET_ID)
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Invalid payload');
    expect(
      json.issues.some(
        (issue: { code: string; keys?: string[] }) =>
          issue.code === 'unrecognized_keys' && issue.keys?.includes('completedAt')
      )
    ).toBe(true);
    expect(mockUpdateFixTicketStatus).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID cliSessionId with 400 and does not write', async () => {
    const res = await POST(
      makeRequest({ status: 'running', cliSessionId: 'kilo-session-not-uuid' }),
      routeContext(TICKET_ID)
    );
    expect(res.status).toBe(400);
    expect(mockUpdateFixTicketStatus).not.toHaveBeenCalled();
  });

  it('returns 401 when the internal secret is missing or wrong', async () => {
    const missing = await POST(
      makeRequest({ status: 'running' }, { secret: null }),
      routeContext(TICKET_ID)
    );
    expect(missing.status).toBe(401);
    const wrong = await POST(
      makeRequest({ status: 'running' }, { secret: 'wrong-secret-wrong-length' }),
      routeContext(TICKET_ID)
    );
    expect(wrong.status).toBe(401);
    expect(mockUpdateFixTicketStatus).not.toHaveBeenCalled();
  });
});
