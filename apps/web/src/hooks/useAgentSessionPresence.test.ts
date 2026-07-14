import * as React from 'react';
import { renderToString } from 'react-dom/server';

import { useAgentSessionPresence } from './useAgentSessionPresence';

const mockUsePresenceSubscription = jest.fn();
const mockUseDocumentVisible = jest.fn();

jest.mock('@kilocode/kilo-chat-hooks', () => ({
  usePresenceSubscription: (...args: unknown[]) => mockUsePresenceSubscription(...args),
}));

jest.mock('./useDocumentVisible', () => ({
  useDocumentVisible: () => mockUseDocumentVisible(),
}));

function TestHarness({ sessionId }: { sessionId: string | null }) {
  useAgentSessionPresence(sessionId);
  return null;
}

beforeEach(() => {
  mockUsePresenceSubscription.mockClear();
  mockUseDocumentVisible.mockClear();
  mockUseDocumentVisible.mockReturnValue(true);
});

describe('useAgentSessionPresence', () => {
  it('subscribes to the exact agent-session context when visible and id is present', () => {
    renderToString(React.createElement(TestHarness, { sessionId: 'session-123' }));

    expect(mockUsePresenceSubscription).toHaveBeenCalledWith(
      '/presence/agent-session/session-123',
      true
    );
  });

  it('passes null context and disabled flag when no session id is provided', () => {
    renderToString(React.createElement(TestHarness, { sessionId: null }));

    expect(mockUsePresenceSubscription).toHaveBeenCalledWith(null, false);
  });

  it('disables the subscription when the document is not visible', () => {
    mockUseDocumentVisible.mockReturnValue(false);

    renderToString(React.createElement(TestHarness, { sessionId: 'session-123' }));

    expect(mockUsePresenceSubscription).toHaveBeenCalledWith(
      '/presence/agent-session/session-123',
      false
    );
  });

  it('sends a new context when the session id changes', () => {
    renderToString(React.createElement(TestHarness, { sessionId: 'session-123' }));

    expect(mockUsePresenceSubscription).toHaveBeenCalledWith(
      '/presence/agent-session/session-123',
      true
    );

    mockUsePresenceSubscription.mockClear();

    renderToString(React.createElement(TestHarness, { sessionId: 'session-456' }));

    expect(mockUsePresenceSubscription).toHaveBeenCalledWith(
      '/presence/agent-session/session-456',
      true
    );
  });
});
