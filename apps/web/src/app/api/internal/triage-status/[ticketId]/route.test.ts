import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { NextRequest } from 'next/server';
import type * as triageTicketsModule from '@/lib/auto-triage/db/triage-tickets';
import type { AutoTriageTicket } from '@/lib/auto-triage/db/types';
import type { POST as PostHandler } from './route';

const mockGetTriageTicketById = jest.fn() as jest.MockedFunction<
  typeof triageTicketsModule.getTriageTicketById
>;
const mockUpdateTriageTicketStatus = jest.fn() as jest.MockedFunction<
  typeof triageTicketsModule.updateTriageTicketStatus
>;
const mockTryDispatchPendingTickets = jest.fn<() => Promise<void>>();
const mockGetBotUserId = jest.fn<() => Promise<string | null>>();

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'test-internal-secret',
}));

jest.mock('@/lib/auto-triage/db/triage-tickets', () => ({
  getTriageTicketById: mockGetTriageTicketById,
  updateTriageTicketStatus: mockUpdateTriageTicketStatus,
}));

jest.mock('@/lib/auto-triage/dispatch/dispatch-pending-tickets', () => ({
  tryDispatchPendingTickets: mockTryDispatchPendingTickets,
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
  invalidJson?: boolean;
};

function makeRequest(body: unknown, options: RequestOptions = {}): NextRequest {
  const url = new URL(
    `https://test.kilo.ai/api/internal/triage-status/${options.ticketId ?? TICKET_ID}`
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
    json: () =>
      options.invalidJson
        ? Promise.reject(new SyntaxError('Unexpected token'))
        : Promise.resolve(body),
  } as unknown as NextRequest;
}

function analyzingTicket(): AutoTriageTicket {
  return {
    id: TICKET_ID,
    status: 'analyzing',
    owned_by_organization_id: null,
    owned_by_user_id: 'user-1',
  } as AutoTriageTicket;
}

function routeContext(ticketId: string) {
  return { params: Promise.resolve({ ticketId }) };
}

// The route reads the internal secret at module scope, so it must load after
// the mock factories above are registered.
let POST: typeof PostHandler;

beforeAll(async () => {
  ({ POST } = await import('./route'));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetTriageTicketById.mockResolvedValue(analyzingTicket());
  mockUpdateTriageTicketStatus.mockResolvedValue(undefined);
  mockGetBotUserId.mockResolvedValue(null);
  mockTryDispatchPendingTickets.mockResolvedValue(undefined);
});

describe('POST /api/internal/triage-status/[ticketId]', () => {
  it('accepts a valid update and forwards only the parsed request fields', async () => {
    const res = await POST(
      makeRequest({
        status: 'actioned',
        classification: 'bug',
        confidence: 0.8,
        intentSummary: 'Crash on startup',
        relatedFiles: ['src/app.ts'],
        actionTaken: 'comment_posted',
        actionMetadata: { labelWarning: 'Failed to apply labels' },
        errorMessage: 'recovered',
      }),
      routeContext(TICKET_ID)
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });
    expect(mockUpdateTriageTicketStatus).toHaveBeenCalledTimes(1);
    expect(mockUpdateTriageTicketStatus).toHaveBeenCalledWith(TICKET_ID, 'actioned', {
      sessionId: undefined,
      classification: 'bug',
      confidence: 0.8,
      intentSummary: 'Crash on startup',
      relatedFiles: ['src/app.ts'],
      isDuplicate: undefined,
      duplicateOfTicketId: undefined,
      similarityScore: undefined,
      actionTaken: 'comment_posted',
      actionMetadata: { labelWarning: 'Failed to apply labels' },
      errorMessage: 'recovered',
    });
  });

  it('accepts a sessionId alongside an analyzing status', async () => {
    const res = await POST(
      makeRequest({ status: 'analyzing', sessionId: 'session-1' }),
      routeContext(TICKET_ID)
    );

    expect(res.status).toBe(200);
    expect(mockUpdateTriageTicketStatus).toHaveBeenCalledWith(
      TICKET_ID,
      'analyzing',
      expect.objectContaining({ sessionId: 'session-1' })
    );
  });

  it('rejects an unknown status value with 400 and does not write', async () => {
    const res = await POST(makeRequest({ status: 'analyzing-again' }), routeContext(TICKET_ID));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Invalid payload');
    expect(mockUpdateTriageTicketStatus).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID ticketId with 400 and does not write', async () => {
    const res = await POST(
      makeRequest({ status: 'analyzing' }, { ticketId: 'not-a-uuid' }),
      routeContext('not-a-uuid')
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Invalid payload');
    expect(mockUpdateTriageTicketStatus).not.toHaveBeenCalled();
  });

  it('rejects server-computed timestamps in the body with 400 and does not write', async () => {
    const res = await POST(
      makeRequest({
        status: 'actioned',
        completedAt: '2026-01-01T00:00:00Z',
        startedAt: '2026-01-01T00:00:00Z',
      }),
      routeContext(TICKET_ID)
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Invalid payload');
    const rejectedKeys = json.issues
      .filter((issue: { code: string }) => issue.code === 'unrecognized_keys')
      .flatMap((issue: { keys?: string[] }) => issue.keys ?? []);
    expect(rejectedKeys).toEqual(expect.arrayContaining(['completedAt', 'startedAt']));
    expect(mockUpdateTriageTicketStatus).not.toHaveBeenCalled();
  });

  it('rejects a malformed JSON body with 400 and does not write', async () => {
    const res = await POST(makeRequest(undefined, { invalidJson: true }), routeContext(TICKET_ID));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Invalid payload');
    expect(mockUpdateTriageTicketStatus).not.toHaveBeenCalled();
  });

  it('returns 401 when the internal secret is missing or wrong', async () => {
    const missing = await POST(
      makeRequest({ status: 'analyzing' }, { secret: null }),
      routeContext(TICKET_ID)
    );
    expect(missing.status).toBe(401);

    const wrong = await POST(
      makeRequest({ status: 'analyzing' }, { secret: 'wrong-secret-wrong-length' }),
      routeContext(TICKET_ID)
    );
    expect(wrong.status).toBe(401);

    expect(mockUpdateTriageTicketStatus).not.toHaveBeenCalled();
  });
});
