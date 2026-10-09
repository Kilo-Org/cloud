import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkingIndicator } from './WorkingIndicator';
import { SessionStatusIndicator } from './SessionStatusIndicator';

Object.assign(globalThis, { React });

describe('WorkingIndicator', () => {
  it('is hidden when the session is idle', () => {
    expect(
      renderToStaticMarkup(
        React.createElement(WorkingIndicator, { messages: [], isStreaming: false })
      )
    ).toBe('');
  });

  it('shows progress during preparation before streaming starts', () => {
    const markup = renderToStaticMarkup(
      React.createElement(WorkingIndicator, {
        messages: [],
        isStreaming: false,
        isPreparing: true,
      })
    );
    expect(markup).toContain('Setting up environment');
    expect(markup).toContain('0s');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('text-primary');
    expect(markup).toContain('text-foreground');
  });

  it('prioritizes preparation over streaming activity', () => {
    const markup = renderToStaticMarkup(
      React.createElement(WorkingIndicator, {
        messages: [],
        isStreaming: true,
        isPreparing: true,
      })
    );
    expect(markup).toContain('Setting up environment');
    expect(markup).not.toContain('Considering next steps');
  });

  it('shows working progress while streaming', () => {
    const markup = renderToStaticMarkup(
      React.createElement(WorkingIndicator, { messages: [], isStreaming: true })
    );
    expect(markup).toContain('Considering next steps');
    expect(markup).toContain('text-primary');
  });
});

describe('SessionStatusIndicator', () => {
  it('renders preparation progress with high-contrast text and an accent spinner', () => {
    const markup = renderToStaticMarkup(
      React.createElement(SessionStatusIndicator, {
        indicator: { type: 'progress', message: 'Preparing session…', timestamp: 0 },
      })
    );
    expect(markup).toContain('Preparing session');
    expect(markup).toContain('text-primary');
    expect(markup).toContain('text-foreground');
    expect(markup).not.toContain('text-muted-foreground');
  });
});
