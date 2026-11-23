import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider, atom, createStore } from 'jotai';
import type { UnreadableQuestionState } from '@kilocode/cloud-agent-sdk';
import type { ToolPart } from './types';
import { QuestionToolStatus } from './QuestionToolStatus';

const mockManagerHolder: { current: unknown } = { current: null };

jest.mock('./CloudAgentProvider', () => ({
  useOptionalManager: () => mockManagerHolder.current,
}));
jest.mock('./ToolCardShell', () => ({
  ToolCardShell: ({ title, subtitle }: { title: string; subtitle?: React.ReactNode }) =>
    React.createElement('div', null, title, subtitle),
}));

function makeQuestionPart(status: ToolPart['state']['status']): ToolPart {
  const questions = [
    {
      question: 'Which approach?',
      header: 'Approach',
      options: [],
    },
  ];
  const input = { questions };
  if (status === 'pending') {
    return {
      id: 'q1',
      sessionID: 'ses_1',
      messageID: 'msg_1',
      type: 'tool',
      callID: 'call_1',
      tool: 'question',
      state: { status: 'pending', input, raw: '' },
    };
  }
  if (status === 'error') {
    return {
      id: 'q1',
      sessionID: 'ses_1',
      messageID: 'msg_1',
      type: 'tool',
      callID: 'call_1',
      tool: 'question',
      state: { status: 'error', input, error: 'dismissed', time: { start: 0, end: 1 } },
    };
  }
  return {
    id: 'q1',
    sessionID: 'ses_1',
    messageID: 'msg_1',
    type: 'tool',
    callID: 'call_1',
    tool: 'question',
    state: {
      status: 'completed',
      input,
      output: '',
      title: '',
      metadata: { answers: [['Option A']] },
      time: { start: 0, end: 1 },
    },
  };
}

describe('QuestionToolStatus without CloudAgentProvider', () => {
  it('renders a completed summary without throwing', () => {
    const html = renderToStaticMarkup(
      React.createElement(QuestionToolStatus, { toolPart: makeQuestionPart('completed') })
    );
    expect(html).toContain('1 answered');
    expect(html).not.toContain('useManager must be used within CloudAgentProvider');
  });

  it('renders a dismissed summary without throwing', () => {
    const html = renderToStaticMarkup(
      React.createElement(QuestionToolStatus, { toolPart: makeQuestionPart('error') })
    );
    expect(html).toContain('Questions dismissed');
  });

  it('renders a pending snapshot without waiting for a live session', () => {
    const html = renderToStaticMarkup(
      React.createElement(QuestionToolStatus, { toolPart: makeQuestionPart('pending') })
    );
    expect(html).toContain('1 asked');
    expect(html).not.toContain('Waiting for answer');
  });
});

it.each(['pending', 'running'] as const)(
  'preserves %s waiting in a live read-only transcript',
  status => {
    const pending = makeQuestionPart('pending');
    const part: ToolPart =
      status === 'running'
        ? {
            ...pending,
            state: { status: 'running', input: pending.state.input, time: { start: 1 } },
          }
        : pending;
    const html = renderToStaticMarkup(
      React.createElement(QuestionToolStatus, {
        toolPart: part,
        presentation: 'live',
        readOnlyState: { isStreaming: true, hasActiveQuestion: false },
      })
    );
    expect(html).toContain('Waiting for answer');
    expect(html).not.toContain('asked');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<input');
  }
);

it('retains terminal summaries for live read-only questions', () => {
  const completed = renderToStaticMarkup(
    React.createElement(QuestionToolStatus, {
      toolPart: makeQuestionPart('completed'),
      presentation: 'live',
      readOnlyState: { isStreaming: true, hasActiveQuestion: false },
    })
  );
  const failed = renderToStaticMarkup(
    React.createElement(QuestionToolStatus, {
      toolPart: makeQuestionPart('error'),
      presentation: 'live',
      readOnlyState: { isStreaming: true, hasActiveQuestion: false },
    })
  );
  expect(completed).toContain('1 answered');
  expect(completed).not.toContain('Waiting for answer');
  expect(failed).toContain('Questions dismissed');
  expect(failed).not.toContain('Waiting for answer');
});

it('uses owner activity changes with an unchanged running question and no mutation controls', () => {
  const pending = makeQuestionPart('pending');
  const part: ToolPart = {
    ...pending,
    state: { status: 'running', input: pending.state.input, time: { start: 1 } },
  };
  for (const [state, label] of [
    [{ isStreaming: true, hasActiveQuestion: false }, 'Waiting for answer'],
    [{ isStreaming: false, hasActiveQuestion: false }, 'Question interrupted'],
    [{ isStreaming: false, hasActiveQuestion: true }, 'Waiting for answer'],
    [{ isStreaming: true, hasActiveQuestion: false }, 'Waiting for answer'],
  ] as const) {
    const html = renderToStaticMarkup(
      React.createElement(QuestionToolStatus, {
        toolPart: part,
        presentation: 'live',
        readOnlyState: state,
      })
    );
    expect(html).toContain(label);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<input');
  }
});

describe('QuestionToolStatus with a live manager', () => {
  beforeEach(() => {
    mockManagerHolder.current = null;
  });

  afterEach(() => {
    mockManagerHolder.current = null;
  });

  function renderWithManager(unreadableQuestions: UnreadableQuestionState[]): string {
    const store = createStore();
    const activeQuestionAtom = atom(null);
    const isStreamingAtom = atom(false);
    const unreadableQuestionsAtom = atom<UnreadableQuestionState[]>(unreadableQuestions);
    store.set(activeQuestionAtom, null);
    store.set(isStreamingAtom, false);
    store.set(unreadableQuestionsAtom, unreadableQuestions);
    mockManagerHolder.current = {
      atoms: {
        activeQuestion: activeQuestionAtom,
        isStreaming: isStreamingAtom,
        unreadableQuestions: unreadableQuestionsAtom,
      },
    };
    return renderToStaticMarkup(
      React.createElement(
        Provider,
        { store },
        React.createElement(QuestionToolStatus, {
          toolPart: makeQuestionPart('pending'),
          presentation: 'live',
        })
      )
    );
  }

  it('waits instead of reporting an interruption for an unreadable question request', () => {
    const html = renderWithManager([{ requestId: 'que-1' }]);

    expect(html).toContain('Waiting for answer');
    expect(html).not.toContain('Question interrupted');
  });

  it('still reports an interruption when no unreadable request is pending', () => {
    const html = renderWithManager([]);

    expect(html).toContain('Question interrupted');
    expect(html).not.toContain('Waiting for answer');
  });
});
