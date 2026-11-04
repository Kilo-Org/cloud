import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PreparationAttempt } from '@kilocode/cloud-agent-sdk';
import { PreparationRow } from './PreparationRow';

Object.assign(globalThis, { React });

describe('PreparationRow output ticker', () => {
  it('fits the indented output preview within the row instead of adding margin to full width', () => {
    const attempt: PreparationAttempt = {
      id: 'attempt-1',
      triggerMessageId: 'message-1',
      status: 'running',
      startedAt: 1000,
      revision: 1,
      steps: [
        {
          id: 'command-1',
          key: 'setup_command:0',
          kind: 'setup_command',
          label: 'Setup command 1',
          command: 'pnpm install',
          status: 'running',
          startedAt: 1000,
          revision: 1,
          outputTail: `Progress: ${'downloaded-package-'.repeat(100)}`,
        },
      ],
    };
    const markup = renderToStaticMarkup(
      React.createElement(PreparationRow, { attempt, onOpenDetails: jest.fn() })
    );
    const tickerClasses = markup.match(/<span aria-hidden="true" class="([^"]+)"/u)?.[1];

    expect(tickerClasses).toBeDefined();
    expect(tickerClasses?.split(' ')).toEqual(
      expect.arrayContaining(['ml-5', 'min-w-0', 'self-stretch', 'overflow-hidden'])
    );
    expect(tickerClasses?.split(' ')).not.toContain('w-full');
    expect(markup).toContain('Progress:');
    expect(markup).toContain('class="w-full truncate"');
  });
});

describe('PreparationRow stopped state', () => {
  it('shows a neutral stop instead of the raw cancellation reason', () => {
    const attempt: PreparationAttempt = {
      id: 'attempt-1',
      triggerMessageId: 'message-1',
      status: 'failed',
      startedAt: 1000,
      completedAt: 13_400,
      revision: 2,
      safeError: 'preparation_cancelled',
      steps: [],
    };
    const markup = renderToStaticMarkup(
      React.createElement(PreparationRow, { attempt, onOpenDetails: jest.fn() })
    );

    expect(markup).toContain('Preparation stopped');
    expect(markup).not.toContain('preparation_cancelled');
    expect(markup).not.toContain('Preparation failed');
  });
});
