import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    protected ctx: unknown;
    protected env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { TriageOrchestrator, formatQuotedIssueTitle } from './triage-orchestrator';
import {
  classificationCallbackPayloadSchema,
  duplicateResultSchema,
  type DuplicateResult,
  type TriageTicket,
} from './types';
import { z } from 'zod';

const postCommentRequestSchema = z.object({
  ticketId: z.string(),
  body: z.string(),
});

const callbackSecret = 'callback-secret';
const cloudAgentSessionId = 'agent_triage';

function createTicket(): TriageTicket {
  return {
    ticketId: 'ticket-1',
    authToken: 'auth-token',
    sessionInput: {
      repoFullName: 'kilocode/example',
      issueNumber: 42,
      issueTitle: 'Failure callback',
      issueBody: null,
      duplicateThreshold: 0.8,
      autoFixThreshold: 0.9,
      modelSlug: 'test-model',
    },
    owner: { type: 'user', id: 'user-1', userId: 'user-1' },
    status: 'pending',
    cloudAgentSessionId,
    callbackSecret,
    updatedAt: '2026-06-10T00:00:00.000Z',
  };
}

function createHarness() {
  let storedState = createTicket();
  const put = vi.fn(async (_key: string, value: TriageTicket) => {
    storedState = structuredClone(value);
  });
  const deleteAlarm = vi.fn(async () => {});
  const setAlarm = vi.fn(async () => {});
  const context = {
    storage: {
      get: async () => structuredClone(storedState),
      put,
      deleteAlarm,
      setAlarm,
    },
  } as unknown as DurableObjectState;
  const environment = {
    API_URL: 'https://api.example.com',
    INTERNAL_API_SECRET: 'internal-secret',
  };
  const orchestrator = new TriageOrchestrator(context, environment as never);

  return { orchestrator, getStoredState: () => storedState, put, deleteAlarm };
}

describe('TriageOrchestrator classification failure callbacks', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 }))
    );
  });

  it('persists the structured failure message instead of the legacy error message', async () => {
    const harness = createHarness();

    await harness.orchestrator.completeClassification(callbackSecret, {
      cloudAgentSessionId,
      status: 'failed',
      errorMessage: 'legacy wrapper error',
      failure: {
        code: 'workspace_setup_failed',
        subtype: 'git_clone_timeout',
        message: 'Repository clone timed out',
      },
    });

    expect(harness.getStoredState()).toMatchObject({
      status: 'failed',
      errorMessage: 'Repository clone timed out',
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.com/api/internal/triage-status/ticket-1',
      expect.objectContaining({
        body: JSON.stringify({
          status: 'failed',
          errorMessage: 'Repository clone timed out',
        }),
      })
    );
  });

  it.each([
    { failure: { code: 'future_failure_code' } },
    { failure: { subtype: 'future_workspace_failure' } },
    { failure: { extra: true } },
    { failure: { attempts: -1 } },
    { failure: { message: 'x'.repeat(4_097) } },
  ])('discards incompatible failure and retains the legacy payload: %o', extension => {
    expect(
      classificationCallbackPayloadSchema.parse({
        cloudAgentSessionId,
        status: 'failed',
        errorMessage: 'legacy wrapper error',
        ...extension,
      })
    ).toEqual({
      cloudAgentSessionId,
      status: 'failed',
      errorMessage: 'legacy wrapper error',
      failure: undefined,
    });
  });

  it('persists the legacy error message when structured failure is absent', async () => {
    const harness = createHarness();

    await harness.orchestrator.completeClassification(callbackSecret, {
      cloudAgentSessionId,
      status: 'failed',
      errorMessage: 'legacy wrapper error',
    });

    expect(harness.getStoredState()).toMatchObject({
      status: 'failed',
      errorMessage: 'legacy wrapper error',
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.com/api/internal/triage-status/ticket-1',
      expect.objectContaining({
        body: JSON.stringify({ status: 'failed', errorMessage: 'legacy wrapper error' }),
      })
    );
  });
});

function validDuplicateResult(): DuplicateResult {
  return {
    isDuplicate: true,
    duplicateOfTicketId: 'ticket-2',
    similarityScore: 0.93,
    similarTickets: [
      {
        ticketId: 'ticket-2',
        issueNumber: 7,
        issueTitle: 'Crash on save',
        similarity: 0.93,
        repoFullName: 'kilocode/example',
      },
    ],
  };
}

function runWithDuplicateResponse(
  responseBody: unknown
): Promise<{ bodies: string[]; fetchMock: ReturnType<typeof vi.fn> }> {
  const fetchMock = vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
    void init;
    const route = String(url).replace('https://api.example.com/api/internal/', '');
    if (route === 'triage/check-duplicates') {
      return new Response(JSON.stringify(responseBody), { status: 200 });
    }
    return new Response(null, { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const orchestrator = createHarness().orchestrator;
  return orchestrator.runTriage().then(() => {
    const bodies = fetchMock.mock.calls
      .filter(call => String(call[0]).endsWith('/api/internal/triage/post-comment'))
      .map(call => {
        const init = call[1];
        if (!init || typeof init.body !== 'string') {
          throw new Error('post-comment fetch call without a body');
        }
        // postComment wraps the comment in {ticketId, body}; parse it as a schema boundary.
        const request = postCommentRequestSchema.parse(JSON.parse(init.body));
        return request.body;
      });
    return { bodies, fetchMock };
  });
}

describe('TriageOrchestrator duplicate notice formatting', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 }))
    );
  });

  it('quotes the duplicate title inside one code span', async () => {
    const title =
      'Broken <a href="https://attacker.example">link</a> cc @org/team visit https://attacker.example';
    const { bodies } = await runWithDuplicateResponse({
      ...validDuplicateResult(),
      similarTickets: [
        {
          ticketId: 'ticket-2',
          issueNumber: 7,
          issueTitle: title,
          similarity: 0.93,
          repoFullName: 'kilocode/example',
        },
      ],
    });

    expect(bodies).toHaveLength(1);
    const body = bodies[0];
    expect(body).toContain(
      'This issue appears to be a duplicate of https://github.com/kilocode/example/issues/7.'
    );
    expect(body).toContain('(#7)');
    // The quoted line must be exactly one code span holding the full title.
    const quotedLine = body.split('\n').find(line => line.startsWith('> **'));
    expect(quotedLine).toBeTruthy();
    const spanMatch = (quotedLine as string).match(/^> \*\*(`+)(.*)\1\*\* \(#7\)$/);
    expect(spanMatch).toBeTruthy();
    if (!spanMatch) return;
    const { 1: delimiter, 2: spanned } = spanMatch;
    // The comment body carries the title text unchanged inside the span.
    expect(spanned).toBe(title);
    // Delimiter must be longer than any backtick run inside the title (none here).
    expect(delimiter).toBe('`');
  });

  it('renders a title made entirely of backticks inside the span', async () => {
    const title = '`````';
    const { bodies } = await runWithDuplicateResponse({
      ...validDuplicateResult(),
      similarTickets: [
        {
          ticketId: 'ticket-2',
          issueNumber: 7,
          issueTitle: title,
          similarity: 0.93,
          repoFullName: 'kilocode/example',
        },
      ],
    });

    const quotedLine = bodies[0].split('\n').find(line => line.startsWith('> **'));
    expect(quotedLine).toBeTruthy();
    const spanMatch = (quotedLine as string).match(/^> \*\*(`+)(.*)\1\*\* \(#7\)$/);
    expect(spanMatch).toBeTruthy();
    if (!spanMatch) return;
    const { 1: delimiter, 2: spanned } = spanMatch;
    // Longest backtick run in the title is 5, so the delimiter is 6.
    expect(delimiter).toBe('``````');
    expect(spanned).toBe(' ````` ');
  });

  it('caps the quoted title at 280 characters with an ellipsis', async () => {
    const { bodies } = await runWithDuplicateResponse({
      ...validDuplicateResult(),
      similarTickets: [
        {
          ticketId: 'ticket-2',
          issueNumber: 7,
          issueTitle: 'y'.repeat(300),
          similarity: 0.93,
          repoFullName: 'kilocode/example',
        },
      ],
    });

    const quotedLine = bodies[0].split('\n').find(line => line.startsWith('> **'));
    expect(quotedLine).toBeTruthy();
    const spanMatch = (quotedLine as string).match(/^> \*\*`+([^\n]*)`+\*\* \(#7\)$/);
    expect(spanMatch).toBeTruthy();
    expect(spanMatch![1]).toBe(`${'y'.repeat(280)}…`);
  });

  it('marks the ticket failed when the duplicate response fails schema validation', async () => {
    const { bodies, fetchMock } = await runWithDuplicateResponse({
      ...validDuplicateResult(),
      similarTickets: [
        {
          ticketId: 'ticket-2',
          issueNumber: 7,
          issueTitle: 'Crash on save',
          similarity: 4.2,
          repoFullName: 'kilocode/example',
        },
      ],
    });

    expect(bodies).toHaveLength(0);
    const statusCalls = fetchMock.mock.calls.filter(call =>
      String(call[0]).includes('/api/internal/triage-status/')
    );
    expect(statusCalls).toHaveLength(2); // 'analyzing' then 'failed'
    const lastInit = statusCalls[1][1];
    if (!lastInit || typeof lastInit.body !== 'string') {
      throw new Error('status call without a body');
    }
    const statusRequest = z
      .object({ status: z.string(), errorMessage: z.string().optional() })
      .parse(JSON.parse(lastInit.body));
    expect(statusRequest.status).toBe('failed');
    expect(statusRequest.errorMessage).toContain('invalid response');
  });
});

describe('formatQuotedIssueTitle', () => {
  it('wraps titles containing markup, mentions, and URLs in a single span', () => {
    const title = 'Use `<b>` and @kilo/dev, see https://example.com/x';
    expect(formatQuotedIssueTitle(title)).toBe(`\`\`${title}\`\``);
  });

  it('lengthens the delimiter when the title contains backticks', () => {
    expect(formatQuotedIssueTitle('a `b` c')).toBe('``a `b` c``');
    expect(formatQuotedIssueTitle('``')).toBe('``` `` ```');
    expect(formatQuotedIssueTitle('`x`')).toBe('`` `x` ``');
  });

  it('truncates long titles and appends an ellipsis', () => {
    expect(formatQuotedIssueTitle('y'.repeat(300))).toBe(`\`${'y'.repeat(280)}…\``);
  });

  it('folds line breaks so the title stays one quoted paragraph', () => {
    expect(formatQuotedIssueTitle('line one\n\ncc @org/team\nline two')).toBe(
      '`line one cc @org/team line two`'
    );
    expect(formatQuotedIssueTitle('a\r\nb\tc')).toBe('`a b c`');
  });
});

describe('duplicateResultSchema', () => {
  it('accepts a well-formed response', () => {
    expect(duplicateResultSchema.parse(validDuplicateResult())).toEqual(validDuplicateResult());
  });

  it('accepts a similarity marginally above 1 from float rounding', () => {
    const result = { ...validDuplicateResult(), similarityScore: 1 + 5e-7 };
    result.similarTickets = [{ ...result.similarTickets[0], similarity: 1 + 5e-7 }];
    expect(duplicateResultSchema.safeParse(result).success).toBe(true);
  });

  it.each([
    [
      'out-of-range similarity',
      {
        ...validDuplicateResult(),
        similarTickets: [{ ...validDuplicateResult().similarTickets[0], similarity: 1.5 }],
      },
    ],
    [
      'malformed repo name',
      {
        ...validDuplicateResult(),
        similarTickets: [
          { ...validDuplicateResult().similarTickets[0], repoFullName: 'not a repo' },
        ],
      },
    ],
    [
      'negative issue number',
      {
        ...validDuplicateResult(),
        similarTickets: [{ ...validDuplicateResult().similarTickets[0], issueNumber: -1 }],
      },
    ],
    [
      'empty ticket id',
      {
        ...validDuplicateResult(),
        similarTickets: [{ ...validDuplicateResult().similarTickets[0], ticketId: '' }],
      },
    ],
  ])('rejects %s', (_label, payload) => {
    expect(duplicateResultSchema.safeParse(payload).success).toBe(false);
  });
});
