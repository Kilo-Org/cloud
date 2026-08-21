import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolPart } from './types';
import { QuestionToolStatus } from './QuestionToolStatus';

jest.mock('./CloudAgentProvider', () => ({
  useOptionalManager: () => null,
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
