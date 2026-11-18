import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolPart } from './types';
import { SuggestToolCard } from './SuggestToolCard';

jest.mock('./CloudAgentProvider', () => ({
  useOptionalManager: () => null,
}));
jest.mock('./ToolCardShell', () => ({
  ToolCardShell: ({ title, subtitle }: { title: string; subtitle?: React.ReactNode }) =>
    React.createElement('div', null, title, subtitle),
}));

function makeSuggestPart(status: ToolPart['state']['status']): ToolPart {
  if (status === 'pending') {
    return {
      id: 's1',
      sessionID: 'ses_1',
      messageID: 'msg_1',
      type: 'tool',
      callID: 'call_1',
      tool: 'suggest',
      state: { status: 'pending', input: {}, raw: '' },
    };
  }
  if (status === 'error') {
    return {
      id: 's1',
      sessionID: 'ses_1',
      messageID: 'msg_1',
      type: 'tool',
      callID: 'call_1',
      tool: 'suggest',
      state: { status: 'error', input: {}, error: 'dismissed', time: { start: 0, end: 1 } },
    };
  }
  return {
    id: 's1',
    sessionID: 'ses_1',
    messageID: 'msg_1',
    type: 'tool',
    callID: 'call_1',
    tool: 'suggest',
    state: {
      status: 'completed',
      input: {},
      output: '',
      title: '',
      metadata: {},
      time: { start: 0, end: 1 },
    },
  };
}

describe('SuggestToolCard without CloudAgentProvider', () => {
  it('renders a compact summary for pending suggestions without throwing', () => {
    const html = renderToStaticMarkup(
      React.createElement(SuggestToolCard, { toolPart: makeSuggestPart('pending') })
    );
    expect(html).toContain('Suggestion');
    expect(html).not.toContain('useManager must be used within CloudAgentProvider');
  });

  it('renders a dismissed summary without throwing', () => {
    const html = renderToStaticMarkup(
      React.createElement(SuggestToolCard, { toolPart: makeSuggestPart('error') })
    );
    expect(html).toContain('Suggestion dismissed');
  });
});
