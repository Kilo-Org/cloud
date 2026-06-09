import { describe, expect, it, vi } from 'vitest';
import type { KiloFacadeHandlerContext } from '../../contracts.js';
import { handleQuestion, parseQuestionRoute } from './handler.js';

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(),
  Sandbox: class Sandbox {},
}));

const rootSessionID = 'ses_12345678901234567890123456';
const childSessionID = 'ses_22222222222222222222222222';

function questionContext(params: {
  method?: string;
  path?: string;
  body?: string;
  responses: Response[];
}): { context: KiloFacadeHandlerContext; containerFetch: ReturnType<typeof vi.fn> } {
  const path = params.path ?? '/question';
  const request = new Request(
    `https://facade.test/kilo${path}?directory=/cloud-agent/sessions/${rootSessionID}`,
    {
      method: params.method ?? 'GET',
      ...(params.body !== undefined
        ? { body: params.body, headers: { 'content-type': 'application/json' } }
        : {}),
    }
  );
  const containerFetch = vi.fn();
  for (const response of params.responses) containerFetch.mockResolvedValueOnce(response);
  return {
    context: {
      request,
      env: {} as KiloFacadeHandlerContext['env'],
      userId: 'user-1',
      url: new URL(request.url),
      kiloPath: path,
      deps: {
        resolveRootSessionForKiloSession: vi
          .fn()
          .mockResolvedValue({ cloudAgentSessionId: 'cloud-1' }),
        resolveLiveWrapper: vi.fn().mockResolvedValue({ sandbox: { containerFetch }, port: 4312 }),
      },
    },
    containerFetch,
  };
}

const rootQuestion = {
  id: 'que_root',
  sessionID: rootSessionID,
  questions: [
    {
      question: 'Proceed?',
      header: 'Proceed',
      options: [
        {
          label: 'Yes',
          description: 'Proceed with the operation',
          labelKey: 'question.yes.label',
          descriptionKey: 'question.yes.description',
          mode: 'build',
        },
      ],
      multiple: false,
      questionKey: 'question.proceed.question',
      headerKey: 'question.proceed.header',
      custom: true,
    },
  ],
  blocking: true,
  tool: { messageID: 'msg_root', callID: 'call_root' },
};
const childQuestion = {
  id: 'que_child',
  sessionID: childSessionID,
  questions: [
    {
      question: 'Child?',
      header: 'Child',
      options: [{ label: 'Yes', description: 'Proceed with the operation' }],
    },
  ],
};

describe('question handler', () => {
  it('recognizes only the allowlisted question routes', () => {
    expect(parseQuestionRoute('GET', '/question')).toEqual({ kind: 'list' });
    expect(parseQuestionRoute('POST', '/question/request-1/reply')).toEqual({
      kind: 'reply',
      requestID: 'request-1',
    });
    expect(parseQuestionRoute('POST', '/question/request-1/reject')).toEqual({
      kind: 'reject',
      requestID: 'request-1',
    });
    expect(parseQuestionRoute('DELETE', '/question/request-1/reject')).toBeNull();
  });

  it('preserves native question entries while filtering child questions', async () => {
    const { context, containerFetch } = questionContext({
      responses: [Response.json([rootQuestion, childQuestion])],
    });
    const response = await handleQuestion(context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([rootQuestion]);
    const request = containerFetch.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    expect(new URL(request.url).search).toBe('');
  });

  it('rejects malformed native question lists', async () => {
    const malformedEntries = [
      { ...rootQuestion, id: 'wrong-question-root' },
      { ...rootQuestion, questions: [{ question: 'Proceed?', header: 'Proceed' }] },
      {
        ...rootQuestion,
        questions: [
          {
            question: 'Proceed?',
            header: 'Proceed',
            options: [{ label: 'Yes' }],
          },
        ],
      },
      { ...rootQuestion, questions: [{ ...rootQuestion.questions[0], multiple: 'yes' }] },
      { ...rootQuestion, blocking: 'yes' },
      { ...rootQuestion, tool: { messageID: 'msg_1' } },
    ];

    for (const malformed of malformedEntries) {
      const { context } = questionContext({ responses: [Response.json([malformed])] });
      const response = await handleQuestion(context);
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({
        error: 'KILO_UPSTREAM_RESPONSE_INVALID',
      });
    }
  });

  it('preflights and forwards a valid native reply body', async () => {
    const nativeResult = { accepted: true };
    const { context, containerFetch } = questionContext({
      method: 'POST',
      path: '/question/que_root/reply',
      body: JSON.stringify({ answers: [['Yes'], ['Other']] }),
      responses: [Response.json([rootQuestion]), Response.json(nativeResult)],
    });
    const response = await handleQuestion(context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(nativeResult);
    expect(containerFetch).toHaveBeenCalledTimes(2);
    const mutationRequest = containerFetch.mock.calls[1]?.[0];
    await expect(mutationRequest.json()).resolves.toEqual({ answers: [['Yes'], ['Other']] });
  });

  it('accepts a native no-underscore ID and uses it for same-root mutation preflight', async () => {
    const nativeQuestion = { ...rootQuestion, id: 'question-root' };
    const { context, containerFetch } = questionContext({
      method: 'POST',
      path: '/question/question-root/reject',
      responses: [Response.json([nativeQuestion]), Response.json(true)],
    });

    const response = await handleQuestion(context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toBe(true);
    expect(containerFetch).toHaveBeenCalledTimes(2);
    expect(new URL(containerFetch.mock.calls[1]?.[0].url).pathname).toBe(
      '/kilo-proxy/question/question-root/reject'
    );
  });

  it('rejects malformed reply bodies before resolving or mutating a wrapper', async () => {
    const { context, containerFetch } = questionContext({
      method: 'POST',
      path: '/question/que_root/reply',
      body: JSON.stringify({ answers: ['Yes'] }),
      responses: [],
    });
    const response = await handleQuestion(context);
    expect(response.status).toBe(400);
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it('does not authorize a mutation from a malformed upstream question ID', async () => {
    const malformedQuestion = { ...rootQuestion, id: 'wrong-question-root' };
    const { context, containerFetch } = questionContext({
      method: 'POST',
      path: '/question/question-root/reject',
      responses: [Response.json([malformedQuestion])],
    });

    const response = await handleQuestion(context);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_UPSTREAM_RESPONSE_INVALID',
    });
    expect(containerFetch).toHaveBeenCalledTimes(1);
  });

  it('returns public 404 without mutation for stale and child question IDs', async () => {
    for (const requestID of ['que_stale', 'que_child']) {
      const { context, containerFetch } = questionContext({
        method: 'POST',
        path: `/question/${requestID}/reject`,
        responses: [Response.json([childQuestion])],
      });
      const response = await handleQuestion(context);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: 'KILO_INTERACTION_REQUEST_NOT_FOUND',
      });
      expect(containerFetch).toHaveBeenCalledTimes(1);
    }
  });
});
